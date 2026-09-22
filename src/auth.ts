// Auth dashboard: satu password admin → sesi token (cookie HttpOnly / Bearer).
// Tanpa ADMIN_PASSWORD: mode terbuka KHUSUS localhost (dev laptop); akses
// non-localhost ditolak. Login dibatasi 5x gagal → kunci 60 detik per IP.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const MAX_FAILS = 5;
export const LOCK_MS = 60_000;

export interface SessionStore {
  sessions: Map<string, number>; // sha256(token) → kedaluwarsa (ms)
  fails: Map<string, { count: number; lockedUntil: number }>;
}

export function createStore(): SessionStore {
  return { sessions: new Map(), fails: new Map() };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Bandingkan password tanpa bocor lewat timing. */
export function verifyPassword(input: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Buat sesi baru; kembalikan token mentah (simpan hash-nya saja). */
export function createSession(store: SessionStore, nowMs: number, ttlMs: number): string {
  prune(store, nowMs);
  const token = randomBytes(32).toString("hex");
  store.sessions.set(hashToken(token), nowMs + ttlMs);
  return token;
}

export function validateSession(store: SessionStore, token: string, nowMs: number): boolean {
  if (!token) return false;
  const exp = store.sessions.get(hashToken(token));
  if (exp === undefined) return false;
  if (exp <= nowMs) { store.sessions.delete(hashToken(token)); return false; }
  return true;
}

export function destroySession(store: SessionStore, token: string): void {
  store.sessions.delete(hashToken(token));
}

export function loginAllowed(store: SessionStore, ip: string, nowMs: number): boolean {
  const f = store.fails.get(ip);
  if (!f) return true;
  if (f.lockedUntil > nowMs) return false;
  if (f.count >= MAX_FAILS && f.lockedUntil <= nowMs) {
    store.fails.delete(ip); // masa kunci habis → hitungan diulang
    return true;
  }
  return true;
}

export function recordLogin(store: SessionStore, ip: string, ok: boolean, nowMs: number): void {
  if (ok) { store.fails.delete(ip); return; }
  const f = store.fails.get(ip) ?? { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) f.lockedUntil = nowMs + LOCK_MS;
  store.fails.set(ip, f);
}

function prune(store: SessionStore, nowMs: number): void {
  for (const [k, exp] of store.sessions) {
    if (exp <= nowMs) store.sessions.delete(k);
  }
  if (store.sessions.size > 1000) store.sessions.clear(); // pengaman ledakan
}

/** true bila IP adalah loopback (mode dev tanpa password). */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "localhost";
}
