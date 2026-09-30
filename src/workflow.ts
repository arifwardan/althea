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
  // waiting_quota DIABAIKAN: tugas itu ditahan sampai cooldown tiba,
  // lalu resumeQuotaTasks mengembalikannya ke queued (FR-4.2).
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
 * Limit terdeteksi (FR-4.1): tugas → waiting_quota (prompt tetap tersimpan →
 * auto-lanjut tanpa prompt ulang), catat episode ke riwayat kuota (FR-4.4).
 * Timer global cooldown tetap diurus enterLimitCooldown (claude.ts).
 */
export function markWaitingQuota(s: AltheaState, id: string, untilIso: string): boolean {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return false;
  const now = new Date().toISOString();
  t.status = "waiting_quota";
  t.updatedAt = now;
  s.quotaHistory.push({
    taskId: id, title: t.title, hitAt: now, resumeAt: null, waitMs: null, until: untilIso,
  });
  if (s.quotaHistory.length > 50) s.quotaHistory = s.quotaHistory.slice(-50);
  logEvent(s, `quota ${id} → waiting_quota (estimated reset ${untilIso})`);
  return true;
}

/** Tutup episode kuota terbuka milik tugas (dipakai resume maupun batal). */
function closeQuotaEntry(s: AltheaState, id: string, nowIso: string): void {
  for (let i = s.quotaHistory.length - 1; i >= 0; i--) {
    const e = s.quotaHistory[i];
    if (e.taskId === id && e.resumeAt === null) {
      e.resumeAt = nowIso;
      e.waitMs = Math.max(0, Date.parse(nowIso) - Date.parse(e.hitAt));
      break;
    }
  }
}

/**
 * Cooldown tiba (FR-4.2): semua tugas waiting_quota → queued agar dikerjakan
 * lagi tanpa prompt ulang. Kembalikan daftar tugas yang di-resume.
 */
export function resumeQuotaTasks(s: AltheaState): StackTask[] {
  const now = new Date().toISOString();
  const out: StackTask[] = [];
  for (const t of s.stack) {
    if (t.status === "waiting_quota") {
      t.status = "queued";
      t.updatedAt = now;
      closeQuotaEntry(s, t.id, now);
      out.push(t);
    }
  }
  if (out.length) logEvent(s, `quota recovered → resume ${out.length} task(s) (${out.map((t) => t.id).join(",")})`);
  return out;
}

/** Batalkan tugas aktif (queued/running/waiting_approval/waiting_quota) → failed. */
export function cancelTask(s: AltheaState, id: string, note = "cancelled by admin"): boolean {
  const t = s.stack.find((x) => x.id === id);
  if (!t) return false;
  if (!["queued", "running", "waiting_approval", "waiting_quota"].includes(t.status)) return false;
  s.approvals = s.approvals.filter((a) => a.id !== id);
  if (t.status === "waiting_quota") closeQuotaEntry(s, id, new Date().toISOString());
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
  const aktif = s.stack.filter((t) => ["queued", "running", "waiting_approval", "waiting_quota"].includes(t.status));
  if (aktif.length === 0) return "Stack empty. /add Title | prompt to fill it.";
  return aktif
    .slice(-10)
    .reverse()
    .map((t, i) => `${i === 0 ? "▶" : "·"} ${t.status} ${t.id} — ${t.title}`)
    .join("\n");
}
