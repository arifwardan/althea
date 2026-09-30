// Pipeline otonom per project: PRD → MVP → fitur (berulang, bounded) → rilis.
// Tiap fase = 1 tugas stack (task.phase). Loop utama memanggil advance/fail
// begitu tugas fase selesai/gagal. Protokol output fase fitur (ala IZIN:):
// akhiri dengan "LANJUT: <sisa>" bila scope PRD belum habis, atau
// "SELESAI: ..." bila sudah — tanpa marker = lanjut ke rilis.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import type { AltheaState, Project, StackTask } from "./state.js";
import { logEvent } from "./state.js";
import { pushTask, cancelTask } from "./workflow.js";
import { projectDir, normalizeStackSpec, normalizeCategories, CATEGORY_DIMS } from "./projects.js";

/** Ronde ke-N dari id fase "fitur-N"; 0 bila bukan fase fitur. */
export function fiturRound(phaseId: string): number {
  const m = /^fitur-(\d+)$/.exec(phaseId);
  return m ? Number(m[1]) : 0;
}

/** Fase berikut setelah phaseId selesai. null = pipeline tamat. */
export function nextPhase(phaseId: string, output: string, maxFitur: number): string | null {
  if (phaseId === "prd") return "mvp";
  if (phaseId === "mvp") return "fitur-1";
  if (phaseId === "rilis") return null;
  const round = fiturRound(phaseId);
  if (round <= 0) return "rilis";
  return /^\s*LANJUT:/m.test(output) && round < maxFitur ? `fitur-${round + 1}` : "rilis";
}

export interface PhaseGraphMode { planMode: "llm" | "slice"; reviewMode: "llm" | "gate"; }

/**
 * Kebijakan hemat token per fase (menimpa GRAPH_PLAN_MODE/GRAPH_REVIEW_MODE):
 * - prd/mvp: plan LLM (sekali per project, cegah rework mahal), review gate sistem.
 * - fitur-N: plan slice + review gate (0 token plan/review; manusia review di dashboard).
 * - rilis: satu-satunya fase dengan review LLM penuh.
 * - null = bukan tugas pipeline → pakai default config.
 */
export function graphModeForPhase(phaseId: string | undefined): PhaseGraphMode | null {
  if (!phaseId) return null;
  if (phaseId === "rilis") return { planMode: "slice", reviewMode: "llm" };
  if (phaseId === "prd" || phaseId === "mvp") return { planMode: "llm", reviewMode: "gate" };
  if (fiturRound(phaseId) > 0) return { planMode: "slice", reviewMode: "gate" };
  return null;
}

/**
 * Batas scope tambahan untuk reviewer LLM per fase. Saat ini hanya fase rilis
 * yang membawa brief: cegah reviewer menggagalkan rilis karena langkah yang
 * memang wewenang admin di luar tugas (tulis riwayat git, install dependensi
 * baru) atau scope PRD yang fase-fitur sebelumnya menundanya eksplisit —
 * keduanya harus diterima sebagai item checklist ✗ yang jujur, bukan alasan
 * gagal. Fase lain → undefined (review standar).
 */
export function reviewBriefForPhase(phaseId: string | undefined): string | undefined {
  if (phaseId !== "rilis") return undefined;
  return [
    "Release-scope review. Judge ONLY what this diff shows:",
    "the release fixes work, README/docs are accurate, and the tree is tidy.",
    "Accept honestly-marked failing checklist items (with a one-line reason)",
    "for steps that need the admin outside this task — git history writes",
    "(commit/push) and new dependency installs — and for PRD scope that",
    "earlier phases explicitly deferred; do NOT fail the release for those.",
  ].join(" ");
}

export interface PhasePromptOpts { stack?: unknown; categories?: unknown; }

/** Title + task prompt for one pipeline phase. Everything is written in English. */
export function buildPhasePrompt(phaseId: string, goal: string, opts: PhasePromptOpts = {}): { title: string; prompt: string } {
  const g = goal.trim() || "(no goal — read PRD.md if present)";
  const spec = normalizeStackSpec(opts.stack);
  const stackLine = `Required stack — BE: ${spec.be}, FE: ${spec.fe}, DB: ${spec.db}, CSS: ${spec.css} (Althea default: Laravel + Svelte + PostgreSQL + Tailwind, preview via lerd).`;
  const cats = normalizeCategories(opts.categories);
  const catBits = CATEGORY_DIMS.filter((d) => cats[d].length).map((d) => `${d}: ${cats[d].join(", ")}`);
  const catLine = catBits.length
    ? `App categories — ${catBits.join("; ")}.`
    : "App categories: not set — decide them from your analysis (function, business model, architecture, target users, interaction) and write them into the PRD.";
  const englishLine = "Write everything in English. If the user's goal or any input is not in English, translate it to English first and work from the translation.";
  if (phaseId === "prd") {
    return {
      title: `PRD: ${g.slice(0, 60)}`,
      prompt: [
        "You are a product analyst + software architect.",
        `User goal: "${g}"`,
        englishLine,
        stackLine,
        catLine,
        "Write a COMPLETE PRD.md in your working directory: vision & users, feature list",
        "(split MVP vs follow-ups + priorities), user stories + acceptance criteria per",
        "feature, stack choice + architecture + folder structure, milestones, and a",
        '"ready-to-sell/deploy" checklist.',
        "End with a 5-line summary: chosen stack + MVP features.",
      ].join("\n"),
    };
  }
  if (phaseId === "mvp") {
    return {
      title: `MVP: ${g.slice(0, 60)}`,
      prompt: [
        "You are an engineer. Read PRD.md in your working directory until you understand it, then",
        "implement the ENTIRE MVP scope until it REALLY RUNS",
        "(buildable/runnable, not stubs). Do not build follow-up features yet.",
        englishLine,
        stackLine,
        "End with: how to run it + a list of what already works.",
      ].join("\n"),
    };
  }
  if (phaseId === "rilis") {
    return {
      title: "Release: verify + deploy-ready",
      prompt: [
        "You are a release engineer. Verify the app runs (build + smoke test via",
        "its run/test commands), fix what is broken, write README.md (how to",
        "install/run/deploy), and tidy the code.",
        englishLine,
        'End with a "ready-to-sell/deploy" checklist: each item ✓/✗ + a one-line reason.',
      ].join("\n"),
    };
  }
  const round = Math.max(1, fiturRound(phaseId));
  return {
    title: `Follow-up features (round ${round})`,
    prompt: [
      "You are an engineer. Read PRD.md in your working directory. Implement the",
      "highest-priority features that do NOT exist yet (several allowed, must keep running).",
      englishLine,
      "End your output with EXACTLY ONE line:",
      '"SELESAI: <summary>" if the ENTIRE PRD scope is implemented and',
      'running, or "LANJUT: <remaining features>" if anything remains.',
    ].join("\n"),
  };
}

function pushPhase(s: AltheaState, p: Project, phaseId: string): StackTask {
  const pipe = p.pipeline as NonNullable<Project["pipeline"]>;
  const { title, prompt } = buildPhasePrompt(phaseId, pipe.goal, { stack: p.stackSpec, categories: p.categories });
  const t = pushTask(s, `[${p.name}] ${title}`.slice(0, 120), prompt, `pipeline ${phaseId}`, p.name);
  t.phase = phaseId;
  pipe.phases = [...pipe.phases.filter((x) => x.id !== phaseId), { id: phaseId, title, taskId: t.id, done: false }];
  pipe.updatedAt = new Date().toISOString();
  return t;
}

/** Mulai pipeline di fase tertentu (mvp = lewati penyusunan PRD). */
export function startPipeline(
  s: AltheaState, project: string, goal: string, startAt = "prd"
): StackTask | null {
  const p = s.projects.find((x) => x.name === project);
  if (!p) return null;
  p.pipeline = {
    goal: goal.trim().slice(0, 1000) || project,
    status: "running",
    phases: [],
    updatedAt: new Date().toISOString(),
  };
  const first = startAt === "mvp" ? "mvp" : "prd";
  logEvent(s, `pipeline ${project} started (goal: ${p.pipeline.goal.slice(0, 80)})`);
  return pushPhase(s, p, first);
}

/** Mulai pipeline; PRD.md sudah ada (upload/zip/repo) → langsung fase mvp. */
export function startPipelineAuto(s: AltheaState, project: string, goal: string): StackTask | null {
  const dir = projectDir(project);
  const hasPrd = !!dir && existsSync(join(dir, "PRD.md"));
  return startPipeline(s, project, goal, hasPrd ? "mvp" : "prd");
}

export interface AdvanceResult {
  pushed?: StackTask;
  finished?: boolean;
  from: string;
  to: string | null;
}

/**
 * Lanjutkan pipeline setelah tugas fase selesai. Kembalikan null bila bukan
 * tugas pipeline / pipeline tak berjalan (paused/done/failed).
 */
export function advancePipeline(
  s: AltheaState, task: StackTask, output: string
): AdvanceResult | null {
  if (!task.phase || !task.project) return null;
  const p = s.projects.find((x) => x.name === task.project);
  const pipe = p?.pipeline;
  if (!p || !pipe || pipe.status !== "running") return null;
  const ph = pipe.phases.find((x) => x.id === task.phase);
  if (ph && ph.taskId === task.id) ph.done = true;
  const next = nextPhase(task.phase, output, config.pipelineFeatureRounds);
  pipe.updatedAt = new Date().toISOString();
  if (!next) {
    pipe.status = "done";
    pipe.note = `finished ${pipe.phases.filter((x) => x.done).length} phases`;
    logEvent(s, `pipeline ${p.name} DONE — ready for release review`);
    return { finished: true, from: task.phase, to: null };
  }
  const t = pushPhase(s, p, next);
  logEvent(s, `pipeline ${p.name}: ${task.phase} → ${next}`);
  return { pushed: t, from: task.phase, to: next };
}

/** Tugas fase gagal/ditolak → pipeline terhenti (failed). */
export function pipelineOnFail(s: AltheaState, taskId: string): { project: string; phase: string } | null {
  const t = s.stack.find((x) => x.id === taskId);
  if (!t?.phase || !t.project) return null;
  const p = s.projects.find((x) => x.name === t.project);
  if (!p?.pipeline || p.pipeline.status !== "running") return null;
  p.pipeline.status = "failed";
  p.pipeline.note = `failed at phase ${t.phase}`;
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${p.name} FAILED at phase ${t.phase}`);
  return { project: p.name, phase: t.phase };
}

/** Tugas fase dibatalkan admin → pipeline dijeda (bisa resume). */
export function pipelineOnCancel(s: AltheaState, taskId: string): boolean {
  const t = s.stack.find((x) => x.id === taskId);
  if (!t?.phase || !t.project) return false;
  const p = s.projects.find((x) => x.name === t.project);
  if (!p?.pipeline || p.pipeline.status !== "running") return false;
  p.pipeline.status = "paused";
  p.pipeline.note = `paused (task ${taskId} cancelled)`;
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${p.name} paused (task ${taskId} cancelled)`);
  return true;
}

/** Jeda pipeline yang berjalan (fase aktif tetap selesai, lanjutan ditahan). */
export function pausePipeline(s: AltheaState, project: string): boolean {
  const p = s.projects.find((x) => x.name === project);
  if (!p?.pipeline || p.pipeline.status !== "running") return false;
  p.pipeline.status = "paused";
  p.pipeline.note = "paused by admin";
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${project} paused`);
  return true;
}

/**
 * Lanjutkan pipeline jeda/gagal. Bila tak ada tugas fase aktif, dorong fase
 * tertunda (atau fase berikut bila semua done).
 */
export function resumePipeline(s: AltheaState, project: string): StackTask | null {
  const p = s.projects.find((x) => x.name === project);
  const pipe = p?.pipeline;
  if (!p || !pipe || !["paused", "failed"].includes(pipe.status)) return null;
  pipe.status = "running";
  pipe.note = undefined;
  pipe.updatedAt = new Date().toISOString();
  const active = s.stack.some((t) =>
    t.project === project && t.phase && ["queued", "running", "waiting_approval", "waiting_quota"].includes(t.status));
  if (active) {
    logEvent(s, `pipeline ${project} resumed`);
    return null;
  }
  const pending = pipe.phases.find((x) => !x.done);
  if (pending) {
    logEvent(s, `pipeline ${project} resumed (retry ${pending.id})`);
    return pushPhase(s, p, pending.id);
  }
  const last = pipe.phases[pipe.phases.length - 1];
  const next = last ? nextPhase(last.id, "", config.pipelineFeatureRounds) : "prd";
  if (!next) {
    pipe.status = "done";
    return null;
  }
  logEvent(s, `pipeline ${project} resumed (${last?.id} → ${next})`);
  return pushPhase(s, p, next);
}

/** Hentikan pipeline + batalkan tugas fasenya yang masih aktif. */
export function cancelPipeline(s: AltheaState, project: string): boolean {
  const p = s.projects.find((x) => x.name === project);
  if (!p?.pipeline || !["running", "paused"].includes(p.pipeline.status)) return false;
  for (const t of s.stack) {
    if (t.project === project && t.phase) cancelTask(s, t.id, "pipeline stopped by admin");
  }
  p.pipeline.status = "failed";
  p.pipeline.note = "stopped by admin";
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${project} stopped by admin`);
  return true;
}
