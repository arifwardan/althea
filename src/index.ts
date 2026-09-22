// Entry: runtime hidup — loop otonom + web + telegram polling.
// Urutan tiap tick: telegram → approval? → tidur? → limit? → kerjakan puncak stack.
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { loadState, saveState, logEvent, appendLog } from "./state.js";
import { addRun, emptyUsage } from "./tokens.js";
import { peek, markDone, markFailed, requestApproval, resolveApproval } from "./workflow.js";
import { processEscalations } from "./escalation.js";
import { isSleeping, forceWake } from "./sleeper.js";
import { runClaude, enterLimitCooldown, limitDue, brainSummary, effectiveBrain } from "./claude.js";
import { checkBrain } from "./metrics.js";
import { projectDir } from "./projects.js";
import { pollTelegram, notifyAdmins, askApproval } from "./telegram.js";
import { startServer } from "./server.js";
import { buildReport } from "./report.js";

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
      forceWake(state, `auto-keputusan ${a.id}`);
      save();
      await notifyAdmins(
        `🤖 KEPUTUSAN OTOMATIS ${act.ok ? "SETUJU ✅" : "TOLAK ⛔"}\n"${a.title}" (${a.id})\n${act.reason}`
      );
    }
  }

  if (state.approvals.length > 0) return; // tunggu izin, jangan kerjakan lain
  if (isSleeping(state)) { save(); return; }
  if (!limitDue(state)) { save(); return; } // cooldown limit → resume saat tiba
  if (working) return;

  // Preflight: jangan bakar ronde graph bila perintah otak tak bisa jalan.
  // Tugas DITAHAN (tetap queued), bukan digagalkan. Notif sekali per episode.
  if (!config.claudeDryRun) {
    const brain = await checkBrain(effectiveBrain().bin);
    if (!brain.ok) {
      const last = state.events[state.events.length - 1] || "";
      if (!last.includes("otak tidak ditemukan")) {
        logEvent(state, `otak tidak ditemukan (${brain.bin}) — cek BRAIN_BIN, tugas ditahan`);
        save();
        await notifyAdmins(
          `🧠 OTAK TIDAK DITEMUKAN\nPerintah "${brain.bin}" gagal dijalankan. Cek BRAIN_BIN di .env lalu restart server. Tugas ditahan (tidak gagal).`
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
      markFailed(state, top.id, `project "${top.project}" tidak ada di workspace`);
      save();
      await notifyAdmins(`❌ Gagal: ${top.title}\nProject "${top.project}" tidak ada di workspace.`);
      return;
    }
    cwd = dir;
  }

  working = true;
  top.status = "running";
  top.attempts += 1;
  logEvent(state, `run ${top.id} (percobaan ${top.attempts})${cwd ? ` @${top.project}` : ""}`);
  save();
  let lastLogSave = 0;
  const pushLine = (line: string) => {
    appendLog(state, top.id, line);
    if (Date.now() - lastLogSave > 2000) { lastLogSave = Date.now(); save(); }
  };
  // Mode graph: plan→implement→review; hasil dinormalisasi ke bentuk runClaude
  // agar limit/IZIN/done/failed ditangani kode yang sama di bawah.
  let graphNote = "";
  let graphIn = 0;
  const runGraphMode = async () => {
    // Lazy import: LangGraph berat dimuat, jangan bebani boot & mode single-shot.
    const { runGraphTask } = await import("./agent/graph.js");
    const g = await runGraphTask({
      task: top, cwd, maxRounds: config.graphMaxRounds,
      autoApprove: config.claudeDryRun,
      onLine: pushLine,
      onEvent: (m) => logEvent(state, `${top.id} ${m}`),
    });
    graphIn = g.inputChars;
    if (g.cancelled) return { ok: false, output: "", hitLimit: false, retryAfterMs: null, cancelled: true };
    if (g.hitLimit) return { ok: false, output: "", hitLimit: true, retryAfterMs: g.retryAfterMs, cancelled: false };
    if (!g.approved) {
      return { ok: false, output: `review tak lolos ${config.graphMaxRounds} ronde. ${g.note}`, hitLimit: false, retryAfterMs: null, cancelled: false };
    }
    graphNote = g.note;
    return { ok: true, output: g.outputs.join("\n"), hitLimit: false, retryAfterMs: null, cancelled: false };
  };
  try {
    const r = config.graphEnabled ? await runGraphMode() : await runClaude(top.prompt, cwd, pushLine);
    // Catat pemakaian (juga untuk run yang dibatalkan/limit — token tetap terpakai).
    const charsIn = config.graphEnabled ? graphIn : [...top.prompt].length;
    const charsOut = [...r.output].length;
    if (!top.usage) top.usage = emptyUsage();
    addRun(top.usage, charsIn, charsOut);
    addRun(state.usage, charsIn, charsOut);
    save(); // pastikan log lengkap tersimpan saat run selesai
    if (r.cancelled) return; // kill-switch: state sudah diurus endpoint cancel
    if (r.hitLimit) {
      top.status = "queued"; // JANGAN done/failed: prompt tersimpan → auto-lanjut
      const until = enterLimitCooldown(state, r.retryAfterMs);
      save();
      await notifyAdmins(
        `⛽ LIMIT TOKEN\nTugas "${top.title}" (${top.id}) ditunda, prompt aman tersimpan.\nResume otomatis: ${until} (±${config.claudeResetHours} jam).\nKetik /bangun untuk cek manual.`
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
        save();
      }
    } else {
      markFailed(state, top.id, r.output.slice(0, 500));
      save();
      await notifyAdmins(`❌ Gagal: ${top.title}\n${r.output.slice(0, 500)}`);
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

console.log(`[althea] hidup. loop ${config.loopSeconds}s · reset ±${config.claudeResetHours}h · dry-run=${config.claudeDryRun ? "ya" : "tidak"} · otak ${brainSummary()}`);
