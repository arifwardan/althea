// State persisten (JSON). Kunci auto-lanjut tanpa prompt ulang:
// setiap tugas menyimpan prompt-nya, jadi boot / reset 5 jam tinggal lanjut.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { emptyUsage, type Usage } from "./tokens.js";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "sleeping"
  | "done"
  | "failed";

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
  graph?: GraphProgress; // progres graph LangGraph (agar resume tak mengulang)
  usage?: Usage; // akumulasi karakter + estimasi token tugas ini
  status: TaskStatus;
  attempts: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  name: string;
  source: string; // URL repo | "zip:<nama-file>" | "manual"
  stack: string; // node | go | python | generic (deteksi otomatis)
  addedAt: string;
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

export interface AltheaState {
  version: 1;
  brain: BrainSetting; // override dashboard (PUT /api/brain), berlaku spawn berikutnya
  stack: StackTask[]; // tumpukan dinamis: puncak = elemen terakhir (LIFO)
  approvals: Approval[];
  projects: Project[]; // registry project di workspace/
  logs: Record<string, string[]>; // taskId → baris output Muse (maks 5 tugas × 200 baris)
  usage: Usage; // total pemakaian runtime ini
  sleepUntil: string | null; // ISO atau null
  limitCooldownUntil: string | null; // ISO: kapan boleh coba Muse lagi setelah limit
  lastReset: string | null;
  events: string[]; // log ringkas (maks 200)
  bootedAt: string;
}

export function defaultState(): AltheaState {
  return {
    version: 1,
    brain: { model: "", effort: "" },
    stack: [],
    approvals: [],
    projects: [],
    logs: {},
    usage: emptyUsage(),
    sleepUntil: null,
    limitCooldownUntil: null,
    lastReset: null,
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
    if (!s.usage || typeof s.usage !== "object") s.usage = emptyUsage();
    if (!s.brain || typeof s.brain !== "object") s.brain = { model: "", effort: "" };
    if (typeof s.brain.model !== "string") s.brain.model = "";
    if (typeof s.brain.effort !== "string") s.brain.effort = "";
    if (!Array.isArray(s.events)) s.events = [];
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
