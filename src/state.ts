// State persisten (JSON). Kunci auto-lanjut tanpa prompt ulang:
// setiap tugas menyimpan prompt-nya, jadi boot / reset 5 jam tinggal lanjut.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { emptyUsage, type Usage } from "./tokens.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_quota"
  | "sleeping"
  | "done"
  | "failed";

/** Satu episode limit kuota (FR-4.4): kapan kena, kapan lanjut, durasi jeda. */
export interface QuotaEvent {
  taskId: string;
  title: string;
  hitAt: string; // kapan limit terdeteksi
  resumeAt: string | null; // kapan selesai menunggu (resume/batal), null = masih menunggu
  waitMs: number | null; // durasi jeda, diisi saat resumeAt diset
  until: string; // estimasi reset saat limit terdeteksi (FR-4.1)
}

export interface GraphProgress {
  plan?: string;
  iteration?: number;
  feedback?: string;
}

export interface StackTask {
  id: string;
  title: string;
  prompt: string; // prompt lengkap untuk Muse CLI — inilah yang di-resume
  project?: string; // nama project di workspace (Muse jalan di folder itu)
  askOnly?: boolean; // /ask: answer only, must not change anything
  phase?: string; // id fase pipeline (prd|mvp|fitur-N|rilis) bila bagian pipeline
  scope?: string[]; // allowlist path relatif yang boleh diubah (FR-3.8); kosong = tak dibatasi
  graph?: GraphProgress; // progres graph LangGraph (agar resume tak mengulang)
  usage?: Usage; // akumulasi karakter + estimasi token tugas ini
  status: TaskStatus;
  attempts: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PipelinePhase {
  id: string; // prd | mvp | fitur-1..N | rilis
  title: string;
  taskId?: string; // tugas terakhir fase ini
  done: boolean;
}

export type PipelineStatus = "running" | "paused" | "done" | "failed";

export interface Pipeline {
  goal: string; // ide/prompt awal user
  status: PipelineStatus;
  phases: PipelinePhase[];
  note?: string;
  updatedAt: string;
}

export interface Project {
  name: string;
  source: string; // URL repo | "zip:<nama-file>" | "blank" | "prd:<nama-file>" | "manual"
  stack: string; // node | go | python | generic (deteksi otomatis)
  stackSpec?: { fe: string; be: string; db: string; css: string }; // pilihan user per lapisan
  categories?: { fungsi: string[]; bisnis: string[]; arsitektur: string[]; target: string[]; interaksi: string[] };
  addedAt: string;
  pipeline?: Pipeline; // alur otonom PRD→MVP→fitur→rilis (opsional)
  mcps?: string[]; // id MCP server aktif untuk project ini (disuntik ke settings CLI saat spawn)
  previewCmd?: string; // command preview kustom (boleh pakai {port}); "" = default stack
}

export type ApprovalStage = "web" | "telegram";
export type DecidedBy = "admin-web" | "admin-telegram" | "auto";

export interface Approval {
  id: string; // == task id
  title: string;
  question: string;
  createdAt: string;
  stage: ApprovalStage; // web dulu 3 mnt → telegram 3 mnt → auto
  escalatedAt: string | null; // kapan dilempar ke telegram
}

export interface BrainSetting {
  model: string; // "" = ikut default env/CLI
  effort: string; // "" = ikut default env/CLI
}

export interface LimitsSetting {
  timeoutSeconds: number; // 0 = ikut default env (CLAUDE_TIMEOUT_SECONDS)
}

/** Satu baris feed aktivitas tugas: tool/file dipanggil saat run. */
export interface TaskActivity {
  t: string; // jam:menit:detik
  kind: string; // tool | file | note
  text: string;
  tool?: string; // nama tool (kind tool saja) — untuk audit terstruktur
  ok?: boolean; // hasil tool: true sukses, false gagal/deny
}

export interface AltheaState {
  version: 1;
  brain: BrainSetting; // override dashboard (PUT /api/brain), berlaku spawn berikutnya
  limits: LimitsSetting; // override dashboard (PUT /api/limits), berlaku spawn berikutnya
  stack: StackTask[]; // tumpukan dinamis: puncak = elemen terakhir (LIFO)
  approvals: Approval[];
  projects: Project[]; // registry project di workspace/
  logs: Record<string, string[]>; // taskId → baris output Muse (maks 5 tugas × 200 baris)
  activity: Record<string, TaskActivity[]>; // taskId → feed aktivitas (maks 5 tugas × 120)
  usage: Usage; // total pemakaian runtime ini
  sleepUntil: string | null; // ISO atau null
  limitCooldownUntil: string | null; // ISO: kapan boleh coba Muse lagi setelah limit
  lastReset: string | null;
  quotaHistory: QuotaEvent[]; // riwayat limit→resume (FR-4.4, maks 50 terakhir)
  events: string[]; // log ringkas (maks 200)
  bootedAt: string;
}

export function defaultState(): AltheaState {
  return {
    version: 1,
    brain: { model: "", effort: "" },
    limits: { timeoutSeconds: 0 },
    stack: [],
    approvals: [],
    projects: [],
    logs: {},
    activity: {},
    usage: emptyUsage(),
    sleepUntil: null,
    limitCooldownUntil: null,
    lastReset: null,
    quotaHistory: [],
    events: [],
    bootedAt: new Date().toISOString(),
  };
}

export function loadState(path: string): AltheaState {
  try {
    if (!existsSync(path)) {
      const s = defaultState();
      saveState(path, s);
      return s;
    }
    const raw = readFileSync(path, "utf8");
    const s = { ...defaultState(), ...JSON.parse(raw) } as AltheaState;
    if (!Array.isArray(s.stack)) s.stack = [];
    if (!Array.isArray(s.approvals)) s.approvals = [];
    if (!Array.isArray(s.projects)) s.projects = [];
    if (!s.logs || typeof s.logs !== "object") s.logs = {};
    if (!s.activity || typeof s.activity !== "object") s.activity = {};
    if (!s.usage || typeof s.usage !== "object") s.usage = emptyUsage();
    if (!s.brain || typeof s.brain !== "object") s.brain = { model: "", effort: "" };
    if (typeof s.brain.model !== "string") s.brain.model = "";
    if (typeof s.brain.effort !== "string") s.brain.effort = "";
    // Migrasi: state lama belum punya override batas eksekusi.
    if (!s.limits || typeof s.limits !== "object") s.limits = { timeoutSeconds: 0 };
    if (!Number.isFinite(s.limits.timeoutSeconds) || (s.limits.timeoutSeconds as number) < 0) {
      s.limits.timeoutSeconds = 0;
    }
    if (!Array.isArray(s.events)) s.events = [];
    // Migrasi: state lama belum punya riwayat kuota (FR-4.4).
    if (!Array.isArray(s.quotaHistory)) s.quotaHistory = [];
    // Migrasi: project lama belum punya MCP / previewCmd / stackSpec / categories.
    // (Struktural saja di sini agar tak ada import siklik ke projects.ts;
    // normalisasi kanonis ada di normalizeStackSpec/normalizeCategories.)
    for (const p of s.projects) {
      if (!Array.isArray((p as Project).mcps)) (p as Project).mcps = [];
      if (typeof (p as Project).previewCmd !== "string") (p as Project).previewCmd = "";
      const legacy = p as Project & { techStack?: unknown; category?: unknown };
      const spec = legacy.stackSpec;
      if (!spec || typeof spec !== "object") {
        const t = typeof legacy.techStack === "string" ? legacy.techStack.trim().toLowerCase() : "";
        const be = ["laravel", "node", "python", "go"].includes(t) ? t : "laravel";
        legacy.stackSpec = { fe: "svelte", be, db: "postgresql", css: "tailwind" };
      }
      delete legacy.techStack;
      const cats = legacy.categories;
      if (!cats || typeof cats !== "object") {
        const c = typeof legacy.category === "string" ? legacy.category.trim().slice(0, 40).toLowerCase() : "";
        legacy.categories = { fungsi: c ? [c] : [], bisnis: [], arsitektur: [], target: [], interaksi: [] };
      } else {
        for (const d of ["fungsi", "bisnis", "arsitektur", "target", "interaksi"] as const) {
          if (!Array.isArray(cats[d])) cats[d] = [];
        }
      }
      delete legacy.category;
    }
    // Migrasi: approval lama sudah dikirim ke telegram → anggap stage telegram.
    for (const a of s.approvals) {
      if (a.stage !== "web" && a.stage !== "telegram") a.stage = "telegram";
      if (a.escalatedAt === undefined) a.escalatedAt = a.createdAt;
    }
    return s;
  } catch {
    return defaultState();
  }
}

export function saveState(path: string, s: AltheaState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2));
}

export function logEvent(s: AltheaState, msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  s.events.push(line);
  if (s.events.length > 200) s.events = s.events.slice(-200);
}

export const uid = (p = "t") =>
  `${p}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** Tambah baris log tugas; pangkas ke 200 baris & 5 tugas terakhir. */
export function appendLog(s: AltheaState, id: string, line: string): void {
  if (!s.logs[id]) s.logs[id] = [];
  const keys = Object.keys(s.logs);
  while (keys.length > 5) delete s.logs[keys.shift() as string];
  const arr = s.logs[id];
  arr.push(line.slice(0, 2000));
  if (arr.length > 200) s.logs[id] = arr.slice(-200);
}

/** Tambah entri aktivitas tugas; pangkas ke 120 entri & 5 tugas terakhir. */
export function appendActivity(
  s: AltheaState, id: string, kind: string, text: string,
  extra?: { tool?: string; ok?: boolean },
): void {
  if (!s.activity[id]) s.activity[id] = [];
  const keys = Object.keys(s.activity);
  while (keys.length > 5) delete s.activity[keys.shift() as string];
  const arr = s.activity[id];
  const e: TaskActivity = { t: new Date().toISOString().slice(11, 19), kind, text: text.slice(0, 200) };
  if (extra?.tool) e.tool = extra.tool;
  if (extra?.ok !== undefined) e.ok = extra.ok;
  arr.push(e);
  if (arr.length > 120) s.activity[id] = arr.slice(-120);
}
