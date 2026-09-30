// Entry: runtime hidup — loop otonom + web + telegram polling.
// Urutan tiap tick: telegram → approval? → tidur? → limit? → kerjakan puncak stack.
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { loadState, saveState, logEvent, appendLog, appendActivity } from "./state.js";
import { addRun, emptyUsage } from "./tokens.js";
import { peek, markDone, markFailed, noteTimeout, requestApproval, resolveApproval, markWaitingQuota, resumeQuotaTasks, buildAskPrompt } from "./workflow.js";
import { processEscalations } from "./escalation.js";
import { isSleeping, forceWake } from "./sleeper.js";
import { runClaude, enterLimitCooldown, limitDue, brainSummary, effectiveBrain, effectiveTimeoutSeconds } from "./claude.js";
import { checkBrain } from "./metrics.js";
import { projectDir } from "./projects.js";
import { advancePipeline, pipelineOnFail, graphModeForPhase, reviewBriefForPhase } from "./pipeline.js";
import { pollTelegram, notifyAdmins, askApproval } from "./telegram.js";
import { startServer } from "./server.js";
import { buildReport } from "./report.js";
import { syncProjectMcps } from "./mcp.js";

const state = loadState(config.statePath);
const save = () => saveState(config.statePath, state);

logEvent(state, `boot (stack: ${state.stack.length}, approval: ${state.approvals.length})`);
save();
startServer(state, save, config.port, config.host);

let working = false;
let lastReport = 0;

async function tick(): Promise<void> {
  await pollTelegram(state, save); // selalu poll: admin bisa bangunkan kapan saja

  // Eskalasi izin: web 3 mnt → telegram 3 mnt → putuskan sendiri.
  const escCfg = {
    webMinutes: config.approvalWebMinutes,
    tgMinutes: config.approvalTelegramMinutes,
    autodecide: config.approvalAutodecide,
  };
  for (const act of processEscalations(state, Date.now(), escCfg)) {
    const a = state.approvals.find((x) => x.id === act.id);
    if (!a) continue;
    if (act.type === "to-telegram") {
      save();
      await askApproval(a.id, a.title, a.question, config.approvalTelegramMinutes);
    } else {
      resolveApproval(state, a.id, act.ok, act.reason, "auto");
      if (!act.ok) pipelineOnFail(state, a.id); // auto-tolak tugas fase → pipeline gagal
      forceWake(state, `auto-decision ${a.id}`);
      save();
      await notifyAdmins(
        `Auto-decision: ${act.ok ? "APPROVED" : "REJECTED"}\nTask: "${a.title}" (${a.id})\nReason: ${act.reason}`
      );
    }
  }

  if (state.approvals.length > 0) return; // tunggu izin, jangan kerjakan lain
  if (isSleeping(state)) { save(); return; }
  const inCooldown = !!state.limitCooldownUntil;
  if (!limitDue(state)) { save(); return; } // cooldown limit → resume saat tiba
  if (inCooldown) {
    // FR-4.2 + FR-4.3: cooldown kedaluwarsa → tugas waiting_quota lanjut
    // otomatis tanpa prompt ulang + notifikasi resume (web via event, Telegram).
    const resumed = resumeQuotaTasks(state);
    save();
    if (resumed.length > 0) {
      await notifyAdmins(
        `Quota recovered — auto-resume\n${resumed.length} task(s) continuing without re-prompting: ${resumed.map((t) => `"${t.title}" (${t.id})`).join(", ")}.`
      );
    }
  }
  if (working) return;

  // Preflight: jangan bakar ronde graph bila perintah otak tak bisa jalan.
  // Tugas DITAHAN (tetap queued), bukan digagalkan. Notif sekali per episode.
  if (!config.claudeDryRun) {
    const brain = await checkBrain(effectiveBrain().bin);
    if (!brain.ok) {
      const last = state.events[state.events.length - 1] || "";
      if (!last.includes("brain not found")) {
        logEvent(state, `brain not found (${brain.bin}) — check BRAIN_BIN, tasks held`);
        save();
        await notifyAdmins(
          `Brain not found\nCommand "${brain.bin}" failed to run. Check BRAIN_BIN in .env, then restart the server. Tasks are held (not failed).`
        );
      } else {
        save();
      }
      return;
    }
  }

  const top = peek(state);
  if (!top) { save(); return; }
  if (top.status === "waiting_approval") return;

  // Tugas terikat project → Muse jalan di workspace/<project> (isolasi cwd).
  // Tanpa project → cwd default (root Althea, perilaku lama).
  let cwd: string | undefined;
  if (top.project) {
    const dir = projectDir(top.project);
    if (!dir || !existsSync(dir)) {
      markFailed(state, top.id, `project "${top.project}" is missing from the workspace`);
      save();
      await notifyAdmins(`Failed: ${top.title}\nProject "${top.project}" is missing from the workspace.`);
      return;
    }
    cwd = dir;
  }

  working = true;
  top.status = "running";
  top.attempts += 1;
  logEvent(state, `run ${top.id} (attempt ${top.attempts})${cwd ? ` @${top.project}` : ""}`);
  save();
  let lastLogSave = 0;
  const pushLine = (line: string) => {
    appendLog(state, top.id, line);
    if (Date.now() - lastLogSave > 2000) { lastLogSave = Date.now(); save(); }
  };
  const pushActivity = (a: { kind: string; text: string; tool?: string; ok?: boolean }) => {
    appendActivity(state, top.id, a.kind, a.text, { tool: a.tool, ok: a.ok });
    if (Date.now() - lastLogSave > 2000) { lastLogSave = Date.now(); save(); }
  };
  // MCP project → suntik ke settings.json CLI sebelum spawn (gagal = lanjut tanpa MCP).
  if (top.project) {
    try {
      const proj = state.projects.find((p) => p.name === top.project);
      const ids = (proj?.mcps || []).filter((id) => typeof id === "string");
      if (ids.length) {
        const mr = syncProjectMcps(ids);
        if (mr.changed) logEvent(state, `mcp sync @${top.project}: ${ids.join(",")}`);
        if (!mr.ok) logEvent(state, `mcp sync @${top.project} failed: ${mr.error} (continuing without MCP)`);
        else for (const st of mr.status) {
          if (st.enabled && st.runnable === false) {
            logEvent(state, `mcp @${top.project}: "${st.id}" not runnable — ${st.setupHint}`);
          }
        }
      }
    } catch (e) {
      logEvent(state, `mcp sync @${top.project} failed: ${String(e)} (continuing without MCP)`);
    }
  }
  // Mode graph: plan→implement→gate/review; hasil dinormalisasi ke bentuk runClaude
  // agar limit/IZIN/done/failed ditangani kode yang sama di bawah.
  // Hemat token: fase pipeline menimpa default config (fitur = slice+gate,
  // review LLM penuh hanya di rilis). Review akhir manusia via panel dashboard.
  let graphNote = "";
  let graphIn = 0;
  const runGraphMode = async () => {
    // Lazy import: LangGraph berat dimuat, jangan bebani boot & mode single-shot.
    const { runGraphTask } = await import("./agent/graph.js");
    const gm = graphModeForPhase(top.phase);
    const g = await runGraphTask({
      task: top.askOnly ? { ...top, prompt: buildAskPrompt(top.prompt) } : top,
      cwd, maxRounds: config.graphMaxRounds,
      autoApprove: config.claudeDryRun,
      planMode: gm?.planMode || config.graphPlanMode,
      reviewMode: gm?.reviewMode || config.graphReviewMode,
      reviewBrief: reviewBriefForPhase(top.phase),
      verify: config.verifyEnabled && cwd
        ? { scripts: config.verifyScripts, timeoutMs: config.verifyTimeoutMs }
        : false,
      onLine: pushLine,
      onEvent: (m) => logEvent(state, `${top.id} ${m}`),
      onActivity: pushActivity,
    });
    graphIn = g.inputChars;
    if (g.cancelled) return { ok: false, output: "", hitLimit: false, retryAfterMs: null, cancelled: true, timedOut: false };
    if (g.hitLimit) return { ok: false, output: "", hitLimit: true, retryAfterMs: g.retryAfterMs, cancelled: false, timedOut: false };
    if (g.timedOut) return { ok: false, output: "", hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: true };
    if (!g.approved) {
      const why = g.reviewKind === "gate"
        ? `system gate failed (${config.graphMaxRounds} rounds, zero LLM tokens). Check the diff in the review panel.`
        : `review failed after ${config.graphMaxRounds} rounds.`;
      return { ok: false, output: `${why} ${g.note}`, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false };
    }
    graphNote = g.note;
    return { ok: true, output: g.outputs.join("\n"), hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false };
  };
  try {
    const askPrompt = top.askOnly ? buildAskPrompt(top.prompt) : top.prompt;
    const r = config.graphEnabled ? await runGraphMode() : await runClaude(askPrompt, cwd, pushLine, pushActivity);
    // Catat pemakaian (juga untuk run yang dibatalkan/limit — token tetap terpakai).
    const charsIn = config.graphEnabled ? graphIn : [...top.prompt].length;
    const charsOut = [...r.output].length;
    if (!top.usage) top.usage = emptyUsage();
    addRun(top.usage, charsIn, charsOut);
    addRun(state.usage, charsIn, charsOut);
    save(); // pastikan log lengkap tersimpan saat run selesai
    if (r.cancelled) return; // kill-switch: state sudah diurus endpoint cancel
    if (r.timedOut) {
      const action = noteTimeout(state, top.id, config.taskMaxAttempts);
      save();
      if (action === "retry") {
        await notifyAdmins(
          `Timeout (${effectiveTimeoutSeconds().seconds}s)\n"${top.title}" (${top.id}) auto-retried — attempt ${top.attempts}/${config.taskMaxAttempts}. Files already written are safe.`
        );
      } else {
        const pf = pipelineOnFail(state, top.id);
        save();
        await notifyAdmins(`Failed: ${top.title}\nTimeout ${config.taskMaxAttempts}x — raise the timeout on the dashboard (System → execution_limit) if the task is genuinely large.` +
          (pf ? `\nPipeline "${pf.project}" stopped at phase ${pf.phase}.` : ""));
      }
    } else if (r.hitLimit) {
      // FR-4.1: JANGAN done/failed — tugas → waiting_quota, prompt tersimpan → auto-lanjut.
      const until = enterLimitCooldown(state, r.retryAfterMs);
      markWaitingQuota(state, top.id, until);
      save();
      await notifyAdmins(
        `Token limit\nTask "${top.title}" (${top.id}) → waiting_quota, prompt safely stored.\nAuto-resume: ${until} (about ${config.claudeResetHours}h).\nSend /wake to check manually.`
      );
    } else if (r.ok) {
      // Konvensi: output diawali "IZIN:" berarti butuh approve admin.
      // Muncul di web dulu; eskalasi ke Telegram + auto-keputusan diatur tick.
      const izin = r.output.match(/^\s*IZIN:\s*(.+)/m);
      if (izin) {
        requestApproval(state, top.id, izin[1].slice(0, 500));
        save();
      } else {
        markDone(state, top.id, (graphNote || r.output).slice(0, 1000));
        if (top.askOnly) {
          await notifyAdmins(`Answer\n"${top.title}"\n\n${(graphNote || r.output).slice(0, 3500)}`);
        }
        // Tugas fase pipeline → dorong fase berikut (atau tamatkan pipeline).
        const adv = advancePipeline(state, top, r.output);
        save();
        if (adv?.pushed) {
          await notifyAdmins(
            `Pipeline ${top.project}: phase ${adv.from} done → continuing to ${adv.to} (${adv.pushed.title}).`
          );
        } else if (adv?.finished) {
          await notifyAdmins(
            `Pipeline done\nProject "${top.project}" finished all phases.\nNext step: review it on the dashboard → projects → review.`
          );
        }
      }
    } else {
      markFailed(state, top.id, r.output.slice(0, 500));
      const pf = pipelineOnFail(state, top.id);
      save();
      await notifyAdmins(`Failed: ${top.title}\n${r.output.slice(0, 500)}` +
        (pf ? `\nPipeline "${pf.project}" stopped at phase ${pf.phase}.` : ""));
    }
  } finally {
    working = false;
  }

  // Laporan berkala
  if (config.reportEveryHours > 0 && Date.now() - lastReport > config.reportEveryHours * 3600_000) {
    lastReport = Date.now();
    await notifyAdmins(buildReport(state));
  }
  save();
}

setInterval(() => void tick(), config.loopSeconds * 1000);
void tick();

const mati = () => { logEvent(state, "shutdown"); save(); process.exit(0); };
process.on("SIGINT", mati);
process.on("SIGTERM", mati);

console.log(`[althea] alive. loop ${config.loopSeconds}s · reset ±${config.claudeResetHours}h · dry-run=${config.claudeDryRun ? "yes" : "no"} · brain ${brainSummary()}`);
