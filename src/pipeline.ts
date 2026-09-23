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
import { projectDir } from "./projects.js";

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

/** Judul + prompt tugas untuk satu fase pipeline. */
export function buildPhasePrompt(phaseId: string, goal: string): { title: string; prompt: string } {
  const g = goal.trim() || "(tanpa goal — baca PRD.md bila ada)";
  if (phaseId === "prd") {
    return {
      title: `PRD: ${g.slice(0, 60)}`,
      prompt: [
        "Kamu analis produk + arsitek software.",
        `Tujuan user: "${g}"`,
        "Tulis PRD.md LENGKAP di direktori kerjamu: visi & pengguna, daftar fitur",
        "(pisahkan MVP vs lanjutan + prioritas), user stories + kriteria terima tiap",
        "fitur, pilihan stack + arsitektur + struktur folder, milestone, dan checklist",
        '"siap jual/deploy".',
        "Akhiri dengan ringkasan 5 baris: stack pilihan + fitur MVP.",
      ].join("\n"),
    };
  }
  if (phaseId === "mvp") {
    return {
      title: `MVP: ${g.slice(0, 60)}`,
      prompt: [
        "Kamu engineer. Baca PRD.md di direktori kerjamu sampai paham, lalu",
        "implementasikan SELURUH scope MVP hingga BENAR-BENAR BERJALAN",
        "(bisa di-build/dijalankan, bukan stub). Jangan kerjakan fitur lanjutan dulu.",
        "Akhiri dengan: cara menjalankan + daftar yang sudah bekerja.",
      ].join("\n"),
    };
  }
  if (phaseId === "rilis") {
    return {
      title: "Rilis: verifikasi + siap deploy",
      prompt: [
        "Kamu release engineer. Verifikasi aplikasi berjalan (build + smoke test via",
        "perintah run/test-nya), perbaiki yang rusak, tulis README.md (cara",
        "install/jalankan/deploy), dan rapikan kode.",
        'Akhiri dengan checklist "siap jual/deploy": tiap item ✓/✗ + alasan singkat.',
      ].join("\n"),
    };
  }
  const round = Math.max(1, fiturRound(phaseId));
  return {
    title: `Fitur lanjutan (ronde ${round})`,
    prompt: [
      "Kamu engineer. Baca PRD.md di direktori kerjamu. Implementasikan fitur",
      "prioritas tertinggi yang BELUM ada (boleh beberapa, wajib tetap berjalan).",
      "Akhiri output dengan TEPAT SATU baris:",
      '"SELESAI: <ringkasan>" jika SELURUH scope PRD sudah terimplementasi dan',
      "berjalan, atau \"LANJUT: <daftar sisa fitur>\" jika masih ada sisa.",
    ].join("\n"),
  };
}

function pushPhase(s: AltheaState, p: Project, phaseId: string): StackTask {
  const pipe = p.pipeline as NonNullable<Project["pipeline"]>;
  const { title, prompt } = buildPhasePrompt(phaseId, pipe.goal);
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
  logEvent(s, `pipeline ${project} mulai (goal: ${p.pipeline.goal.slice(0, 80)})`);
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
    pipe.note = `tamat ${pipe.phases.filter((x) => x.done).length} fase`;
    logEvent(s, `pipeline ${p.name} SELESAI — siap review rilis`);
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
  p.pipeline.note = `gagal di fase ${t.phase}`;
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${p.name} GAGAL di fase ${t.phase}`);
  return { project: p.name, phase: t.phase };
}

/** Tugas fase dibatalkan admin → pipeline dijeda (bisa resume). */
export function pipelineOnCancel(s: AltheaState, taskId: string): boolean {
  const t = s.stack.find((x) => x.id === taskId);
  if (!t?.phase || !t.project) return false;
  const p = s.projects.find((x) => x.name === t.project);
  if (!p?.pipeline || p.pipeline.status !== "running") return false;
  p.pipeline.status = "paused";
  p.pipeline.note = `jeda (tugas ${taskId} dibatalkan)`;
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${p.name} jeda (tugas ${taskId} dibatalkan)`);
  return true;
}

/** Jeda pipeline yang berjalan (fase aktif tetap selesai, lanjutan ditahan). */
export function pausePipeline(s: AltheaState, project: string): boolean {
  const p = s.projects.find((x) => x.name === project);
  if (!p?.pipeline || p.pipeline.status !== "running") return false;
  p.pipeline.status = "paused";
  p.pipeline.note = "dijeda admin";
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${project} jeda`);
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
    t.project === project && t.phase && ["queued", "running", "waiting_approval"].includes(t.status));
  if (active) {
    logEvent(s, `pipeline ${project} lanjut`);
    return null;
  }
  const pending = pipe.phases.find((x) => !x.done);
  if (pending) {
    logEvent(s, `pipeline ${project} lanjut (ulangi ${pending.id})`);
    return pushPhase(s, p, pending.id);
  }
  const last = pipe.phases[pipe.phases.length - 1];
  const next = last ? nextPhase(last.id, "", config.pipelineFeatureRounds) : "prd";
  if (!next) {
    pipe.status = "done";
    return null;
  }
  logEvent(s, `pipeline ${project} lanjut (${last?.id} → ${next})`);
  return pushPhase(s, p, next);
}

/** Hentikan pipeline + batalkan tugas fasenya yang masih aktif. */
export function cancelPipeline(s: AltheaState, project: string): boolean {
  const p = s.projects.find((x) => x.name === project);
  if (!p?.pipeline || !["running", "paused"].includes(p.pipeline.status)) return false;
  for (const t of s.stack) {
    if (t.project === project && t.phase) cancelTask(s, t.id, "pipeline dihentikan admin");
  }
  p.pipeline.status = "failed";
  p.pipeline.note = "dihentikan admin";
  p.pipeline.updatedAt = new Date().toISOString();
  logEvent(s, `pipeline ${project} dihentikan admin`);
  return true;
}
