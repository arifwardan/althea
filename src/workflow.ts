// Workflow dinamis model STACK (LIFO).
// - push(): tambah kerja (bisa sub-tugas saat runtime → "dinamis").
// - pop(): ambil puncak untuk dikerjakan. Selesai → done, gagal → failed.
// - Tugas menunggu izin TIDAK dibuang: status waiting_approval, tetap di puncak.
import type { AltheaState, DecidedBy, StackTask } from "./state.js";
import { uid, logEvent } from "./state.js";

export function pushTask(
  s: AltheaState,
  title: string,
  prompt: string,
  note = "",
  project?: string
): StackTask {
  const now = new Date().toISOString();
  const t: StackTask = {
    id: uid(),
    title: title.slice(0, 120) || "(tanpa judul)",
    prompt,
    ...(project ? { project } : {}),
    status: "queued",
    attempts: 0,
    note,
    createdAt: now,
    updatedAt: now,
  };
  s.stack.push(t);
  logEvent(s, `push ${t.id} "${t.title}" (dalam: ${s.stack.length})`);
  return t;
}

export function peek(s: AltheaState): StackTask | undefined {
  // Puncak = tugas aktif teratas yang belum done/failed.
  for (let i = s.stack.length - 1; i >= 0; i--) {
    const t = s.stack[i];
    if (t.status === "queued" || t.status === "running" || t.status === "waiting_approval") {
      return t;
    }
  }
  return undefined;
}

export function markDone(s: AltheaState, id: string, note = ""): void {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return;
  t.status = "done";
  t.updatedAt = new Date().toISOString();
  if (note) t.note = note;
  logEvent(s, `done ${id}`);
}

export function markFailed(s: AltheaState, id: string, note = ""): void {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return;
  t.status = "failed";
  t.updatedAt = new Date().toISOString();
  if (note) t.note = note;
  logEvent(s, `failed ${id} ${note}`.slice(0, 300));
}

/** Minta izin: tugas tetap di puncak, engine berhenti sampai approve/reject. */
export function requestApproval(s: AltheaState, id: string, question: string): void {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return;
  t.status = "waiting_approval";
  t.updatedAt = new Date().toISOString();
  if (!s.approvals.some((a) => a.id === id)) {
    s.approvals.push({
      id, title: t.title, question,
      createdAt: new Date().toISOString(), stage: "web", escalatedAt: null,
    });
  }
  logEvent(s, `approval? ${id} ${question}`.slice(0, 300));
}

export function resolveApproval(
  s: AltheaState, id: string, ok: boolean, note = "", by: DecidedBy = "admin-web"
): boolean {
  const i = s.approvals.findIndex((a) => a.id === id);
  if (i < 0) return false;
  s.approvals.splice(i, 1);
  const t = s.stack.find((x) => x.id === id);
  if (!t) return true;
  t.updatedAt = new Date().toISOString();
  if (ok) {
    t.status = "queued"; // lanjut dikerjakan
    t.note = note || t.note;
    logEvent(s, `approval OK ${id} [${by}] → queued`);
  } else {
    t.status = "failed";
    t.note = note || "ditolak";
    logEvent(s, `approval TOLAK ${id} [${by}]`);
  }
  return true;
}

/** Batalkan tugas aktif (queued/running/waiting_approval) → failed. */
export function cancelTask(s: AltheaState, id: string, note = "dibatalkan admin"): boolean {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return false;
  if (!["queued", "running", "waiting_approval"].includes(t.status)) return false;
  s.approvals = s.approvals.filter((a) => a.id !== id);
  t.status = "failed";
  t.note = note;
  t.updatedAt = new Date().toISOString();
  logEvent(s, `batal ${id} (${note})`.slice(0, 200));
  return true;
}

export function stackSummary(s: AltheaState): string {
  const aktif = s.stack.filter((t) => ["queued", "running", "waiting_approval"].includes(t.status));
  if (aktif.length === 0) return "Stack kosong. /tambah Judul | prompt untuk isi.";
  return aktif
    .slice(-10)
    .reverse()
    .map((t, i) => `${i === 0 ? "▶" : "·"} ${t.status} ${t.id} — ${t.title}`)
    .join("\n");
}
