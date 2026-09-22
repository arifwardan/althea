// Aturan eskalasi izin: muncul di web dulu; tanpa respons dalam
// N menit → dilempar ke Telegram; tanpa respons M menit lagi →
// Althea memutuskan sendiri (non-destruktif = lanjut, destruktif = tolak).
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";

export interface EscalationConfig {
  webMinutes: number;
  tgMinutes: number;
  autodecide: boolean;
}

export type EscalationAction =
  | { type: "to-telegram"; id: string }
  | { type: "auto-decide"; id: string; ok: boolean; reason: string };

// Kata kunci aksi destruktif/berisiko → keputusan otomatis selalu TOLAK.
const DESTRUCTIVE =
  /(hapus|delete|drop|destroy|remove|rm\s+-rf?|format|deploy\s+produksi|production|prod\b|revoke|cabut|buang|buang semua|menimpa|overwrite|reset\s+(db|database|prod)|bayar|transfer|kirim\s+uang)/i;

/** Keputusan otomatis saat admin diam di kedua kanal. */
export function autoDecide(question: string): { ok: boolean; reason: string } {
  const m = question.match(DESTRUCTIVE);
  if (m) {
    return {
      ok: false,
      reason: `ditolak otomatis: terdeteksi aksi berisiko ("${m[0]}") dan tanpa respons admin — default-deny agar aman`,
    };
  }
  return {
    ok: true,
    reason: "disetujui otomatis: aksi non-destruktif dan tanpa respons admin di web maupun Telegram",
  };
}

const MIN = 60_000;

/**
 * Cek semua approval pending terhadap jam `nowMs`. Mengubah stage yang
 * kedaluwarsa dan mengembalikan aksi yang harus dijalankan caller
 * (kirim Telegram / resolve + notifikasi). Murni soal waktu → gampang dites.
 */
export function processEscalations(
  s: AltheaState,
  nowMs: number,
  cfg: EscalationConfig
): EscalationAction[] {
  const actions: EscalationAction[] = [];
  for (const a of s.approvals) {
    if (a.stage === "web" && nowMs - Date.parse(a.createdAt) >= cfg.webMinutes * MIN) {
      a.stage = "telegram";
      a.escalatedAt = new Date(nowMs).toISOString();
      logEvent(s, `eskalasi ${a.id} web→telegram (tanpa respons ${cfg.webMinutes} mnt)`);
      actions.push({ type: "to-telegram", id: a.id });
    } else if (
      a.stage === "telegram" &&
      a.escalatedAt &&
      cfg.autodecide &&
      nowMs - Date.parse(a.escalatedAt) >= cfg.tgMinutes * MIN
    ) {
      const d = autoDecide(a.question);
      logEvent(s, `auto-keputusan ${a.id}: ${d.ok ? "SETUJU" : "TOLAK"} (${d.reason})`.slice(0, 300));
      actions.push({ type: "auto-decide", id: a.id, ok: d.ok, reason: d.reason });
    }
  }
  return actions;
}

/** Sisa waktu (ms) sebelum naik stage; <=0 berarti kedaluwarsa. */
export function stageRemainingMs(
  a: { stage: string; createdAt: string; escalatedAt: string | null },
  nowMs: number,
  cfg: EscalationConfig
): number {
  if (a.stage === "web") return Date.parse(a.createdAt) + cfg.webMinutes * MIN - nowMs;
  if (a.escalatedAt) return Date.parse(a.escalatedAt) + cfg.tgMinutes * MIN - nowMs;
  return 0;
}
