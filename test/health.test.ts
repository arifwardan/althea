// FR-8.1 healthcheck: GET /healthz publik tanpa auth (versi + uptime),
// sementara /api/* tetap 401 tanpa login.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";

// Auth WAJIB aktif agar terbukti /healthz memang bypass auth.
// Dipasang sebelum import modul server (config dibaca saat import).
process.env.ADMIN_PASSWORD = "rahasia-test-healthz";

const { startServer } = await import("../src/server.js");
const { defaultState } = await import("../src/state.js");

const PORT = 18911;
const BASE = `http://127.0.0.1:${PORT}`;
let srv: Server | null = null;

async function tungguHidup(): Promise<void> {
  if (!srv) srv = startServer(defaultState(), () => {}, PORT, "127.0.0.1");
  const batas = Date.now() + 15_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* belum listen */ }
    if (Date.now() > batas) throw new Error("server test tak kunjung hidup");
    await new Promise((r) => setTimeout(r, 100));
  }
}

after(async () => {
  if (srv) await new Promise<void>((done) => srv!.close(() => done()));
});

describe("GET /healthz (FR-8.1)", () => {
  it("200 tanpa auth berisi ok + versi + uptime", async () => {
    await tungguHidup();
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 200);
    const b = (await r.json()) as { ok: boolean; version: string; uptimeSec: number; now: string };
    assert.equal(b.ok, true);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    assert.equal(b.version, pkg.version);
    assert.ok(typeof b.uptimeSec === "number" && b.uptimeSec >= 0);
    assert.ok(!Number.isNaN(Date.parse(b.now)));
  });
  it("/api/state tetap privat (401) tanpa login", async () => {
    await tungguHidup();
    const r = await fetch(`${BASE}/api/state`);
    assert.equal(r.status, 401);
  });
});
