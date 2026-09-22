// Agen LangGraph di atas Muse CLI langganan (tanpa API key).
// Topologi: plan → implement → review → (approve | fix→implement, maks N ronde).
// Tiap node = satu panggilan CLI; limit/kill di dilempar sebagai sinyal agar
// loop utama menangani via jalur cooldown & kill-switch yang sudah ada.
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { runClaude, type ClaudeResult } from "../claude.js";
import { listFiles, projectDiff } from "../projects.js";
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

export type RunFn = (
  prompt: string, cwd?: string, onLine?: (line: string) => void
) => Promise<ClaudeResult>;

export interface GraphProgress { plan?: string; iteration?: number; feedback?: string }

export interface GraphOpts {
  task: StackTask;
  cwd?: string;
  maxRounds: number;
  autoApprove?: boolean; // dry-run: review lolos otomatis
  run?: RunFn;
  getDiff?: () => Promise<string>; // default: git diff project
  getTree?: () => string; // default: daftar file project
  onLine?: (line: string) => void;
  onEvent?: (msg: string) => void;
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
  approved: boolean;
}

const GState = Annotation.Root({
  title: Annotation<string>,
  prompt: Annotation<string>,
  plan: Annotation<string | null>,
  feedback: Annotation<string | null>,
  iteration: Annotation<number>,
  tree: Annotation<string>,
  verdict: Annotation<string | null>,
  approved: Annotation<boolean>,
  outputs: Annotation<string[]>({ reducer: (a, b) => a.concat(b) }),
});

type S = typeof GState.State;

export function buildPlanPrompt(title: string, prompt: string, tree: string): string {
  return [
    "Kamu perencana. Buat rencana bernomor singkat (maks 10 langkah) untuk tugas ini.",
    "Jawab HANYA rencana, tanpa basa-basi.",
    `Judul: ${title}`,
    `Instruksi: ${prompt}`,
    `File project:\n${tree}`,
  ].join("\n");
}

export function buildImplementPrompt(
  prompt: string, plan: string, feedback: string | null, attempt: number
): string {
  return [
    "Kamu pelaksana. Kerjakan sesuai rencana di direktori kerjamu.",
    `Rencana:\n${plan}`,
    feedback ? `Masukan reviewer (WAJIB diperbaiki):\n${feedback}` : "",
    `Instruksi:\n${prompt}`,
    attempt > 1 ? `(Percobaan ke-${attempt}: jika dulu bertanya IZIN dan admin menyetujui, lanjutkan tanpa bertanya lagi.)` : "",
    "Jika butuh izin admin, tulis baris diawali 'IZIN: ...'. Akhiri dengan ringkasan hasil kerjamu.",
  ].filter(Boolean).join("\n");
}

export function buildReviewPrompt(plan: string, diff: string): string {
  return [
    "Kamu reviewer ketat. Periksa perubahan terhadap rencana.",
    `Rencana:\n${plan}`,
    `Perubahan:\n${diff}`,
    "Jika sudah sesuai dan tanpa kesalahan jelas, jawab persis satu baris: APPROVED",
    "Jika belum, jawab: FEEDBACK: <kekurangan konkret bernomor>",
  ].join("\n");
}

export function parseReview(output: string): { verdict: "approve" | "fix"; feedback: string | null } {
  if (/^\s*APPROVED\b/m.test(output)) return { verdict: "approve", feedback: null };
  const m = output.match(/FEEDBACK:\s*([\s\S]+)/);
  if (m) return { verdict: "fix", feedback: m[1].trim().slice(0, 2000) };
  return { verdict: "fix", feedback: output.trim().slice(0, 2000) || "belum ada umpan balik" };
}

function throwIfSpecial(r: ClaudeResult): void {
  if (r.cancelled) throw new CancelledSignal();
  if (r.hitLimit) throw new LimitSignal(r.retryAfterMs);
}

export function buildGraph(opts: {
  run: RunFn; cwd?: string; maxRounds: number; autoApprove: boolean;
  getDiff: () => Promise<string>;
  onLine?: (line: string) => void; onEvent?: (msg: string) => void; onProgress?: (g: GraphProgress) => void;
}) {
  const { run, cwd, maxRounds, autoApprove, getDiff, onLine, onEvent, onProgress } = opts;
  const line = (node: string) => (l: string) => onLine?.(`[${node}] ${l}`);

  const graph = new StateGraph(GState)
    .addNode("planner", async (s: S) => {
      onEvent?.("graph → plan");
      const r = await run(buildPlanPrompt(s.title, s.prompt, s.tree), cwd, line("planner"));
      throwIfSpecial(r);
      onProgress?.({ plan: r.output });
      return { plan: r.output, outputs: [`[plan]\n${r.output}`] };
    })
    .addNode("coder", async (s: S) => {
      onEvent?.(`graph → implement (ronde ${s.iteration + 1})`);
      const r = await run(
        buildImplementPrompt(s.prompt, s.plan || "-", s.feedback, s.iteration + 1),
        cwd, line("coder")
      );
      throwIfSpecial(r);
      return { outputs: [`[implement]\n${r.output}`] };
    })
    .addNode("reviewer", async (s: S) => {
      onEvent?.("graph → review");
      if (autoApprove) {
        return { verdict: "approve", approved: true, outputs: ["[review] auto-approve (dry-run)"] };
      }
      const diff = await getDiff();
      const r = await run(buildReviewPrompt(s.plan || "-", diff), cwd, line("reviewer"));
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
    .addConditionalEdges(START, (s: S) => (s.plan ? "coder" : "planner"))
    .addEdge("planner", "coder")
    .addEdge("coder", "reviewer")
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
    return inner(prompt, cwd, onLine);
  };
  const tree = o.getTree
    ? o.getTree()
    : (() => {
      if (!o.task.project) return "-";
      const lf = listFiles(o.task.project, 80);
      return lf.ok && lf.files?.length ? lf.files.map((f) => f.path).join("\n") : "-";
    })();
  const getDiff = o.getDiff || (async () => {
    if (!o.task.project) return "(tanpa project — review dari output teks)";
    const d = await projectDiff(o.task.project);
    if (!d.repo) return "(bukan repo git — review dari daftar file)";
    return `${d.stat}\n\n${(d.diff || "").slice(0, 4000)}`;
  });

  const saveProgress = (g: GraphProgress) => {
    o.task.graph = { ...(o.task.graph || {}), ...g };
    o.onProgress?.(g);
  };

  const graph = buildGraph({
    run, cwd: o.cwd, maxRounds: o.maxRounds, autoApprove: o.autoApprove || false,
    getDiff, onLine: o.onLine, onEvent: o.onEvent, onProgress: saveProgress,
  });

  try {
    const final = await graph.invoke({
      title: o.task.title,
      prompt: o.task.prompt,
      plan: o.task.graph?.plan ?? null,
      feedback: o.task.graph?.feedback ?? null,
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
      approved: final.approved,
    };
  } catch (e) {
    if (e instanceof CancelledSignal) {
      return { ok: false, outputs: [], note: "", inputChars, hitLimit: false, retryAfterMs: null, cancelled: true, approved: false };
    }
    if (e instanceof LimitSignal) {
      return { ok: false, outputs: [], note: "", inputChars, hitLimit: true, retryAfterMs: e.retryAfterMs, cancelled: false, approved: false };
    }
    throw e;
  }
}
