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
  project?: string,
  scope?: string[],
  opts?: { askOnly?: boolean },
): StackTask {
  const now = new Date().toISOString();
  const t: StackTask = {
    id: uid(),
    title: title.slice(0, 120) || "(untitled)",
    prompt,
    ...(project ? { project } : {}),
    ...(scope?.length ? { scope: scope.map((x) => x.trim()).filter(Boolean).slice(0, 50) } : {}),
    ...(opts?.askOnly ? { askOnly: true as const } : {}),
    status: "queued",
    attempts: 0,
    note,
    createdAt: now,
    updatedAt: now,
  };
  s.stack.push(t);
  logEvent(s, `push ${t.id} "${t.title}" (depth: ${s.stack.length})`);
  return t;
}

/**
 * Koreksi tugas yang sedang berjalan/antre: arahan admin ditempel ke prompt,
 * progres graph dibuang (plan ulang bersih), tugas kembali queued.
 * Pemanggil menghentikan proses yang sedang jalan bila ada.
 * Hanya untuk status running/queued; koreksi kosong/hasil selesai → false.
 */
export function correctTask(s: AltheaState, id: string, correction: string): boolean {
  const t = s.stack.find((x) => x.id === id);
  const text = String(correction || "").trim().slice(0, 2000);
  if (!t || !text) return false;
  if (t.status !== "running" && t.status !== "queued") return false;
  t.prompt = `${t.prompt}\n\nAdmin correction: ${text}`;
  t.graph = undefined;
  t.status = "queued";
  t.updatedAt = new Date().toISOString();
  logEvent(s, `correct ${id} (requeued)`);
  return true;
}

/** Tindak lanjut atas tugas lama: project diwarisi, note menaut ke induk. */
export function pushFollowup(s: AltheaState, parentId: string, prompt: string): StackTask | null {
  const parent = s.stack.find((x) => x.id === parentId);
  if (!parent || !prompt.trim()) return null;
  return pushTask(
    s,
    `follow-up: ${parent.title}`.slice(0, 120),
    prompt.trim(),
    `followup ${parentId}`,
    parent.project,
  );
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

/**
 * Catat timeout satu eksekusi: antre-ulang selama attempts < maks (file yang
 * sudah ditulis aman di cwd → run berikut melanjutkan), else gagalkan.
 */
export function noteTimeout(s: AltheaState, id: string, maxAttempts: number): "retry" | "fail" {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return "fail";
  if (t.attempts < maxAttempts) {
    t.status = "queued";
    t.updatedAt = new Date().toISOString();
    logEvent(s, `timeout ${id} → requeue (${t.attempts}/${maxAttempts})`);
    return "retry";
  }
  markFailed(s, id, `timeout ${maxAttempts}× — raise the timeout (dashboard System → execution_limit / CLAUDE_TIMEOUT_SECONDS) if the task is genuinely large`);
  return "fail";
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
    t.note = note || "rejected";
    logEvent(s, `approval REJECT ${id} [${by}]`);
  }
  return true;
}

/**
 * Hasil run basi bila status tugas berubah saat run berjalan
 * (correct → queued, cancel → failed): jangan diterapkan agar tak menimpa
 * status baru. Run yang sehat selalu selesai dengan status "running".
 */
export function shouldApplyRunResult(t: StackTask): boolean {
  return t.status === "running";
}

/**
 * Jalankan (ulang) tugas yang sudah selesai/gagal tanpa mengubah prompt:
 * status kembali queued agar loop mengambilnya. Progres graph dipertahankan
 * (lanjut dari feedback terakhir), attempts tak diubah.
 */
export function requeueTask(s: AltheaState, id: string): boolean {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return false;
  if (t.status !== "done" && t.status !== "failed") return false;
  t.status = "queued";
  t.updatedAt = new Date().toISOString();
  logEvent(s, `requeue ${id}`);
  return true;
}

/**
 * Hapus tugas dari stack sepenuhnya (beda dengan cancel yang menyisakan
 * jejak failed). Approval, log, dan aktivitas miliknya ikut dibersihkan.
 * Pemanggil mematikan proses + menjeda pipeline bila perlu sebelum ini.
 */
export function deleteTask(s: AltheaState, id: string): boolean {
  const i = s.stack.findIndex((x) => x.id === id);
  if (i < 0) return false;
  s.stack.splice(i, 1);
  s.approvals = s.approvals.filter((a) => a.id !== id);
  delete s.logs[id];
  delete s.activity[id];
  logEvent(s, `delete ${id}`);
  return true;
}

/**
 * Minta izin: baca baris "IZIN: ..." dari output AI. Toleran terhadap gaya
 * tulis AI: bold markdown di kiri/kanan (`**IZIN:** ...`, `**IZIN**: ...`),
 * spasi sebelum titik-dua, huruf besar/kecil. Kembalikan pertanyaan
 * (maks 500 char) atau null bila tak ada permintaan izin.
 */
export function parseIzinRequest(output: string): string | null {
  const m = String(output || "").match(/^\s*\*{0,2}IZIN\*{0,2}\s*:\s*\*{0,2}\s*(.+)/im);
  if (!m) return null;
  const q = m[1].replace(/\*+$/, "").trim();
  return q ? q.slice(0, 500) : null;
}

/** Batalkan tugas aktif (queued/running/waiting_approval) → failed. */
export function cancelTask(s: AltheaState, id: string, note = "cancelled by admin"): boolean {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return false;
  if (!["queued", "running", "waiting_approval"].includes(t.status)) return false;
  s.approvals = s.approvals.filter((a) => a.id !== id);
  t.status = "failed";
  t.note = note;
  t.updatedAt = new Date().toISOString();
  logEvent(s, `cancel ${id} (${note})`.slice(0, 200));
  return true;
}

/** Read-only wrapper for /ask tasks: answer the question, change nothing. */
export function buildAskPrompt(question: string): string {
  return [
    "You are answering a question in READ-ONLY mode.",
    "Answer ONLY with the answer, in English (translate the question first if it is not English).",
    "Strictly forbidden: creating, modifying, deleting, or moving any file; running any command that changes system state (no installs, no writes, no commits, no deploys).",
    "Allowed: reading files and listing directories when needed to answer accurately.",
    `Question: ${question.trim()}`,
  ].join("\n");
}

export function stackSummary(s: AltheaState): string {
  const aktif = s.stack.filter((t) => ["queued", "running", "waiting_approval"].includes(t.status));
  if (aktif.length === 0) return "Stack empty. /add Title | prompt to fill it.";
  return aktif
    .slice(-10)
    .reverse()
    .map((t, i) => `${i === 0 ? "▶" : "·"} ${t.status} ${t.id} — ${t.title}`)
    .join("\n");
}
