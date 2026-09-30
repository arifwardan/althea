// Agen LangGraph di atas Muse CLI langganan (tanpa API key).
// Topologi: plan → implement → review → (approve | fix→implement, maks N ronde).
// Tiap node = satu panggilan CLI; limit/kill di dilempar sebagai sinyal agar
// loop utama menangani via jalur cooldown & kill-switch yang sudah ada.
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { runClaude, type ClaudeResult } from "../claude.js";
import { contextTree, projectDiff, readStandards, prdSlice } from "../projects.js";
import { runVerifyGates } from "../verify.js";
import type { StackTask } from "../state.js";

/** Limit kuota di tengah graph → driver wajib cooldown + simpan progres. */
export class LimitSignal extends Error {
  retryAfterMs: number | null;
  constructor(retryAfterMs: number | null) {
    super("limit");
    this.retryAfterMs = retryAfterMs;
  }
}

/** Kill-switch di tengah graph → state sudah diurus endpoint cancel. */
export class CancelledSignal extends Error {}

/** Timer Althea membunuh satu node → driver antre-ulang seluruh tugas. */
export class TimeoutSignal extends Error {}

export type RunFn = (
  prompt: string, cwd?: string, onLine?: (line: string) => void,
  onActivity?: (a: { kind: string; text: string; tool?: string; ok?: boolean }) => void,
) => Promise<ClaudeResult>;

export interface GraphProgress { plan?: string; iteration?: number; feedback?: string }

export type PlanMode = "llm" | "slice"; // slice = rencana dari potongan instruksi, 0 token LLM
export type ReviewMode = "llm" | "gate"; // gate = cek diff oleh sistem, 0 token LLM

export interface GraphOpts {
  task: StackTask;
  cwd?: string;
  maxRounds: number;
  autoApprove?: boolean; // dry-run: review lolos otomatis
  planMode?: PlanMode; // default "llm" (kompatibel lama)
  reviewMode?: ReviewMode; // default "llm" (kompatibel lama)
  reviewBrief?: string; // batas scope tambahan untuk prompt reviewer (mis. fase rilis)
  verify?: { scripts: string[]; timeoutMs: number } | false; // default: aktif bila ada cwd
  run?: RunFn;
  getDiff?: () => Promise<string>; // default: git diff project
  getTree?: () => string; // default: daftar file project
  onLine?: (line: string) => void;
  onEvent?: (msg: string) => void;
  onActivity?: (a: { kind: string; text: string; tool?: string; ok?: boolean }) => void;
  onProgress?: (g: GraphProgress) => void; // dipanggil tiap node (agar resume tak mengulang)
}

export interface GraphResult {
  ok: boolean;
  outputs: string[];
  note: string;
  inputChars: number; // total karakter prompt semua node (untuk estimasi token)
  hitLimit: boolean;
  retryAfterMs: number | null;
  cancelled: boolean;
  timedOut: boolean;
  approved: boolean;
  reviewKind: ReviewMode; // mode review yang dipakai run ini (untuk pesan hasil)
}

const GState = Annotation.Root({
  title: Annotation<string>,
  prompt: Annotation<string>,
  plan: Annotation<string | null>,
  feedback: Annotation<string | null>,
  verifyOk: Annotation<boolean | null>,
  iteration: Annotation<number>,
  tree: Annotation<string>,
  verdict: Annotation<string | null>,
  approved: Annotation<boolean>,
  outputs: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

type S = typeof GState.State;

export function buildPlanPrompt(title: string, prompt: string, tree: string): string {
  return [
    "You are a planner. Write a short numbered plan (max 10 steps) for this task.",
    "Answer with ONLY the plan, no preamble.",
    "Write in English. If the instructions are not in English, translate them to English first.",
    `Title: ${title}`,
    `Instructions: ${prompt}`,
    `Project files:\n${tree}`,
  ].join("\n");
}

export function buildImplementPrompt(
  prompt: string, plan: string, feedback: string | null, attempt: number, scope?: string[]
): string {
  return [
    "You are an implementer. Work according to the plan in your working directory.",
    "Write everything in English: code, comments, summaries, and any file content. If the instructions or plan are not in English, translate them to English first.",
    `Plan:\n${plan}`,
    feedback ? `Reviewer feedback (MUST fix):\n${feedback}` : "",
    `Instructions:\n${prompt}`,
    attempt > 1 ? `(Attempt ${attempt}: if you previously asked IZIN and the admin approved, continue without asking again.)` : "",
    "Change only files relevant to the task; do not touch other files.",
    scope?.length ? `Scope limit (do NOT change files outside this list):\n${scope.join("\n")}` : "",
    "Do not paste entire file contents into the output (the system reads the diff from git) — a summary + the list of changed files is enough.",
    "If you need admin approval, write a line starting with 'IZIN: ...'. End with a summary of your work.",
  ].filter(Boolean).join("\n");
}

export interface ReviewExtra { verifySummary?: string | null; brief?: string | null; }

export function buildReviewPrompt(plan: string, diff: string, extra: ReviewExtra = {}): string {
  return [
    "You are a strict reviewer. Check the changes against the plan.",
    "Write in English.",
    extra.brief ? `Scope:\n${extra.brief}` : "",
    `Plan:\n${plan}`,
    extra.verifySummary
      ? `Machine verifier result (authoritative for build/test status — trust it over prose claims in either direction):\n${extra.verifySummary}`
      : "",
    `Changes:\n${diff}`,
    "If it matches and there are no clear mistakes, answer with exactly one line: APPROVED",
    "If not, answer: FEEDBACK: <numbered concrete shortcomings>",
  ].filter(Boolean).join("\n");
}

export function parseReview(output: string): { verdict: "approve" | "fix"; feedback: string | null } {
  if (/^\s*APPROVED\b/m.test(output)) return { verdict: "approve", feedback: null };
  const m = output.match(/FEEDBACK:\s*([\s\S]+)/);
  if (m) return { verdict: "fix", feedback: m[1].trim().slice(0, 2000) };
  return { verdict: "fix", feedback: output.trim().slice(0, 2000) || "no feedback" };
}

/**
 * Rencana tanpa ronde LLM: potongan instruksi tugas (maks 8 baris / 600 char).
 * Cukup sebagai panduan coder untuk kerja kecil; kerja besar tetap pakai plan LLM.
 */
export function buildSlicePlan(title: string, prompt: string, maxChars = 600): string {
  const body = prompt.trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8).join("\n");
  return [
    `Auto plan (no LLM round) for: ${title}`,
    body.slice(0, maxChars) || "-",
  ].join("\n");
}

export interface GateVerdict { verdict: "approve" | "fix"; feedback: string | null; }

/**
 * Review oleh sistem (0 token LLM): lolos bila diff menunjukkan perubahan.
 * Diff yang tak bisa dinilai mesin (tanpa project / bukan repo git) diloloskan —
 * manusia me-review via panel dashboard Althea.
 */
export function runGateReview(diff: string): GateVerdict {
  const t = (diff || "").trim();
  if (!t) return { verdict: "fix", feedback: "system gate: no changes detected (empty diff)" };
  if (/^\(no project|^\(not a git repo/.test(t)) return { verdict: "approve", feedback: null };
  if (/^diff --git/m.test(t) || /^[+][^+]/m.test(t) || /\|\s*\d+\s*[+-]+/.test(t)) {
    return { verdict: "approve", feedback: null };
  }
  return { verdict: "fix", feedback: "system gate: diff adds no lines — make sure files were actually written" };
}

function throwIfSpecial(r: ClaudeResult): void {
  if (r.cancelled) throw new CancelledSignal();
  if (r.hitLimit) throw new LimitSignal(r.retryAfterMs);
  if (r.timedOut) throw new TimeoutSignal();
}

export function buildGraph(opts: {
  run: RunFn; cwd?: string; maxRounds: number; autoApprove: boolean;
  planMode?: PlanMode; reviewMode?: ReviewMode; reviewBrief?: string;
  scope?: string[];
  verify?: { scripts: string[]; timeoutMs: number } | false;
  getDiff: () => Promise<string>;
  onLine?: (line: string) => void; onEvent?: (msg: string) => void; onProgress?: (g: GraphProgress) => void;
}) {
  const { run, cwd, maxRounds, autoApprove, getDiff, onLine, onEvent, onProgress } = opts;
  const verifyCfg = opts.verify === undefined ? { scripts: ["check", "test", "build"], timeoutMs: 120_000 } : opts.verify;
  const planMode: PlanMode = opts.planMode || "llm";
  const reviewMode: ReviewMode = opts.reviewMode || "llm";
  const line = (node: string) => (l: string) => onLine?.(`[${node}] ${l}`);

  const graph = new StateGraph(GState)
    .addNode("planner", async (s: S) => {
      if (planMode === "slice") {
        const plan = buildSlicePlan(s.title, s.prompt);
        onEvent?.("graph → plan (slice, 0 LLM tokens)");
        onProgress?.({ plan });
        return { plan, outputs: [`[plan-slice]\n${plan}`] };
      }
      onEvent?.("graph → plan");
      const r = await run(buildPlanPrompt(s.title, s.prompt, s.tree), cwd, line("planner"));
      throwIfSpecial(r);
      onProgress?.({ plan: r.output });
      return { plan: r.output, outputs: [`[plan]\n${r.output}`] };
    })
    .addNode("coder", async (s: S) => {
      onEvent?.(`graph → implement (round ${s.iteration + 1})`);
      const r = await run(
        buildImplementPrompt(s.prompt, s.plan || "-", s.feedback, s.iteration + 1, opts.scope),
        cwd, line("coder")
      );
      throwIfSpecial(r);
      return { outputs: [`[implement]\n${r.output}`] };
    })
    .addNode("reviewer", async (s: S) => {
      if (autoApprove) {
        onEvent?.("graph → review");
        return { verdict: "approve", approved: true, outputs: ["[review] auto-approve (dry-run)"] };
      }
      // Verifier gagal = hard gate: tak ada ronde review LLM, langsung fix.
      if (s.verifyOk === false) {
        onEvent?.("graph → review skipped (verifier failed)");
        return {
          verdict: "fix",
          approved: false,
          feedback: s.feedback,
          iteration: s.iteration,
          outputs: ["[review] skipped — fix the verifier failures first"],
        };
      }
      const diff = await getDiff();
      if (reviewMode === "gate") {
        const g = runGateReview(diff);
        onEvent?.(`graph → gate ${g.verdict} (0 LLM tokens)`);
        if (g.verdict === "fix") onProgress?.({ iteration: s.iteration + 1, feedback: g.feedback || undefined });
        return {
          verdict: g.verdict,
          approved: g.verdict === "approve",
          feedback: g.feedback,
          iteration: g.verdict === "fix" ? s.iteration + 1 : s.iteration,
          outputs: [`[review-gate]\n${g.verdict === "approve" ? "APPROVED (gate sistem)" : `FEEDBACK: ${g.feedback}`}`],
        };
      }
      onEvent?.("graph → review");
      // Bukti mesin (bukan klaim prosa) + batas scope fase ikut ke reviewer.
      const verifyNote = [...s.outputs].reverse().find((t) => t.startsWith("[verify]")) ?? null;
      const r = await run(
        buildReviewPrompt(s.plan || "-", diff, { verifySummary: verifyNote, brief: opts.reviewBrief ?? null }),
        cwd, line("reviewer"));
      throwIfSpecial(r);
      const p = parseReview(r.output);
      if (p.verdict === "fix") onProgress?.({ iteration: s.iteration + 1, feedback: p.feedback || undefined });
      return {
        verdict: p.verdict,
        approved: p.verdict === "approve",
        feedback: p.feedback,
        iteration: p.verdict === "fix" ? s.iteration + 1 : s.iteration,
        outputs: [`[review]\n${r.output}`],
      };
    })
    .addNode("verify", async (s: S) => {
      // FR-3.10: gate deterministik setelah implementasi (0 token LLM).
      // Dilewati bila: dry-run, tanpa cwd, atau verify=false.
      if (autoApprove || !verifyCfg || !cwd) return {};
      onEvent?.("graph → verify (0 LLM tokens)");
      const v = await runVerifyGates(cwd, verifyCfg.scripts, verifyCfg.timeoutMs);
      onLine?.(`[verify] ${v.summary.split("\n")[0]}`);
      if (!v.ok) {
        const fb = [s.feedback, v.summary].filter(Boolean).join("\n").slice(0, 2000);
        onProgress?.({ iteration: s.iteration + 1, feedback: fb });
        return { verifyOk: false, feedback: fb, iteration: s.iteration + 1, outputs: [`[verify]\n${v.summary}`] };
      }
      return { verifyOk: true, outputs: [`[verify]\n${v.summary}`] };
    })
    .addConditionalEdges(START, (s: S) => (s.plan ? "coder" : "planner"))
    .addEdge("planner", "coder")
    .addEdge("coder", "verify")
    .addEdge("verify", "reviewer")
    .addConditionalEdges("reviewer", (s: S) =>
      s.verdict === "approve" || s.iteration >= maxRounds ? END : "coder"
    )
    .compile();
  return graph;
}

/** Jalankan graph untuk satu tugas; progres ditulis ke task.graph agar resume. */
export async function runGraphTask(o: GraphOpts): Promise<GraphResult> {
  const inner = o.run || runClaude;
  let inputChars = 0;
  const run: RunFn = async (prompt, cwd, onLine) => {
    inputChars += [...prompt].length;
    return inner(prompt, cwd, onLine, o.onActivity);
  };
  // FR-3.8: pohon konteks terpangkas (bukan daftar 80 file mentah).
  const tree = o.getTree ? o.getTree() : (!o.task.project ? "-" : contextTree(o.task.project));
  // FR-3.11: STANDARDS.md project disuntik ke prompt (dicatat di inputChars — jujur).
  const standards = o.task.project ? readStandards(o.task.project) : null;
  // FR-3.8: potongan PRD untuk fase eksekusi (bukan fase prd yang justru menulisnya).
  const slice = o.task.project && o.task.phase && o.task.phase !== "prd" ? prdSlice(o.task.project) : null;
  const extras = [
    standards ? `<PROJECT STANDARDS (must follow):>\n${standards}\n</PROJECT STANDARDS>` : "",
    slice ? `<PRD SUMMARY (read the full PRD.md only if this slice is insufficient):>\n${slice}\n</PRD SUMMARY>` : "",
  ].filter(Boolean).join("\n\n");
  const augmentedPrompt = extras ? `${o.task.prompt}\n\n${extras}` : o.task.prompt;
  const getDiff = o.getDiff || (async () => {
    if (!o.task.project) return "(no project — review from text output)";
    const d = await projectDiff(o.task.project);
    if (!d.repo) return "(not a git repo — review from the file list)";
    return `${d.stat}\n\n${(d.diff || "").slice(0, 4000)}`;
  });

  const saveProgress = (g: GraphProgress) => {
    o.task.graph = { ...(o.task.graph || {}), ...g };
    o.onProgress?.(g);
  };

  const planMode: PlanMode = o.planMode || "llm";
  const reviewMode: ReviewMode = o.reviewMode || "llm";
  const graph = buildGraph({
    run, cwd: o.cwd, maxRounds: o.maxRounds, autoApprove: o.autoApprove || false,
    planMode, reviewMode, reviewBrief: o.reviewBrief, scope: o.task.scope, verify: o.verify,
    getDiff, onLine: o.onLine, onEvent: o.onEvent, onProgress: saveProgress,
  });

  try {
    const final = await graph.invoke({
      title: o.task.title,
      prompt: augmentedPrompt,
      plan: o.task.graph?.plan ?? null,
      feedback: o.task.graph?.feedback ?? null,
      verifyOk: null,
      iteration: o.task.graph?.iteration ?? 0,
      tree,
      verdict: null,
      approved: false,
      outputs: [],
    });
    const impl = [...final.outputs].reverse().find((t) => t.startsWith("[implement]"));
    return {
      ok: final.approved,
      outputs: final.outputs,
      note: (impl || final.outputs[final.outputs.length - 1] || "").replace(/^\[implement\]\n/, "").slice(0, 1000),
      inputChars,
      hitLimit: false,
      retryAfterMs: null,
      cancelled: false,
      timedOut: false,
      approved: final.approved,
      reviewKind: reviewMode,
    };
  } catch (e) {
    if (e instanceof CancelledSignal) {
      return { ok: false, outputs: [], note: "", inputChars, hitLimit: false, retryAfterMs: null, cancelled: true, timedOut: false, approved: false, reviewKind: reviewMode };
    }
    if (e instanceof LimitSignal) {
      return { ok: false, outputs: [], note: "", inputChars, hitLimit: true, retryAfterMs: e.retryAfterMs, cancelled: false, timedOut: false, approved: false, reviewKind: reviewMode };
    }
    if (e instanceof TimeoutSignal) {
      return { ok: false, outputs: [], note: "", inputChars, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: true, approved: false, reviewKind: reviewMode };
    }
    throw e;
  }
}
