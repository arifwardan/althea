// Mode tidur: hemat kuota + hening, tapi TETAP BANGUN untuk:
// 1) pesan Telegram admin, 2) approval, 3) timer reset limit tiba, 4) tugas prioritas.
// Implementasi: sleepUntil (ISO). Cek via isSleeping(); forceWake() untuk interupsi.
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";

export function goSleep(s: AltheaState, minutes: number): string {
  const until = new Date(Date.now() + Math.max(1, minutes) * 60_000).toISOString();
  s.sleepUntil = until;
  logEvent(s, `tidur sampai ${until}`);
  return until;
}

export function forceWake(s: AltheaState, why: string): void {
  if (!s.sleepUntil) return;
  s.sleepUntil = null;
  logEvent(s, `bangun: ${why}`.slice(0, 200));
}

/** true = masih tidur (loop utama harus skip eksekusi Muse). */
export function isSleeping(s: AltheaState, now = new Date()): boolean {
  if (!s.sleepUntil) return false;
  if (new Date(s.sleepUntil).getTime() <= now.getTime()) {
    s.sleepUntil = null; // kedaluwarsa → bangun otomatis
    logEvent(s, "bangun otomatis (jadwal tiba)");
    return false;
  }
  return true;
}

/** Event yang membangunkan walau sedang tidur. */
export type WakeEvent =
  | "telegram"
  | "approval"
  | "reset_due"
  | "priority"
  | "manual";

export function shouldWake(ev: WakeEvent): boolean {
  return true; // semua 5 pemicu di atas membangunkan
}
