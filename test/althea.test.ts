// Kontrak inti Althea: limit→resume, approval, stack LIFO, tidur.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultState, appendLog } from "../src/state.js";
import { pushTask, peek, markDone, requestApproval, resolveApproval, cancelTask, stackSummary } from "../src/workflow.js";
import { killRunning } from "../src/claude.js";
import { detectLimit, parseRetryAfter, enterLimitCooldown, limitDue } from "../src/claude.js";
import { goSleep, forceWake, isSleeping } from "../src/sleeper.js";

describe("deteksi limit token", () => {
  it("mengenali pola limit umum", () => {
    for (const t of [
      "Error: usage limit reached, try again in 5 minutes",
      "429 Too Many Requests",
      "quota exceeded for this period",
      "API overloaded, please retry",
      "Rate limit hit. Reset at midnight",
    ]) {
      assert.equal(detectLimit(t), true, t);
    }
  });
  it("tidak false-positive pada output normal", () => {
    assert.equal(detectLimit("done: 3 files changed, tests passed"), false);
    assert.equal(detectLimit("IZIN: boleh deploy ke staging?"), false);
  });
  it("parseRetryAfter membaca 'try again in N unit'", () => {
    assert.equal(parseRetryAfter("try again in 5 minutes"), 5 * 60_000);
    assert.equal(parseRetryAfter("Try again in 2 hours"), 2 * 3_600_000);
    assert.equal(parseRetryAfter("try again in 30 detik"), 30_000);
    assert.equal(parseRetryAfter("limit reached"), null);
  });
});

describe("cooldown + resume otomatis", () => {
  it("enterLimitCooldown memakai retryAfter bila ada, else +5 jam", () => {
    const s = defaultState();
    const until = enterLimitCooldown(s, 60_000);
    assert.ok(s.limitCooldownUntil === until);
    assert.ok(Date.now() < new Date(until).getTime());
    assert.equal(limitDue(s), false); // masih cooldown → tick harus skip
  });
  it("limitDue true + reset flag saat waktunya tiba", () => {
    const s = defaultState();
    enterLimitCooldown(s, 1_000);
    const nanti = new Date(Date.now() + 60_000);
    assert.equal(limitDue(s, nanti), true);
    assert.equal(s.limitCooldownUntil, null);
    assert.ok(s.lastReset);
  });
});

describe("workflow stack LIFO + approval", () => {
  it("puncak = tugas terakhir yang belum selesai", () => {
    const s = defaultState();
    const a = pushTask(s, "A", "prompt-a");
    pushTask(s, "B", "prompt-b");
    assert.equal(peek(s)?.id, s.stack[1].id);
    markDone(s, s.stack[1].id);
    assert.equal(peek(s)?.id, a.id);
  });
  it("approval: setuju → queued, tolak → failed", () => {
    const s = defaultState();
    const t = pushTask(s, "Deploy", "deploy ke staging");
    requestApproval(s, t.id, "Boleh deploy?");
    assert.equal(peek(s)?.status, "waiting_approval");
    assert.equal(s.approvals.length, 1);
    assert.equal(resolveApproval(s, t.id, true), true);
    assert.equal(peek(s)?.status, "queued");
    requestApproval(s, t.id, "Yakin?");
    assert.equal(resolveApproval(s, t.id, false, "jangan dulu"), true);
    assert.equal(peek(s), undefined);
  });
  it("resolveApproval id tak dikenal → false", () => {
    assert.equal(resolveApproval(defaultState(), "t_takada", true), false);
  });
  it("stackSummary ramah saat kosong", () => {
    assert.match(stackSummary(defaultState()), /kosong/);
  });
});

describe("cancelTask (kill-switch)", () => {
  it("tugas aktif → failed + approval dibersihkan", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    requestApproval(s, t.id, "izin?");
    assert.equal(cancelTask(s, t.id), true);
    assert.equal(s.stack[0].status, "failed");
    assert.equal(s.approvals.length, 0);
  });
  it("tugas selesai/tak dikenal → false", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    markDone(s, t.id);
    assert.equal(cancelTask(s, t.id), false);
    assert.equal(cancelTask(s, "t_takada"), false);
  });
  it("killRunning tanpa proses → false", () => {
    assert.equal(killRunning(), false);
  });
});

describe("appendLog", () => {
  it("pangkas 200 baris & 5 tugas", () => {
    const s = defaultState();
    for (let i = 0; i < 250; i++) appendLog(s, "a", `l${i}`);
    assert.equal(s.logs.a.length, 200);
    assert.equal(s.logs.a[0], "l50");
    for (const id of ["b", "c", "d", "e", "f", "g"]) appendLog(s, id, "x");
    assert.equal(Object.keys(s.logs).length, 5);
    assert.ok(!("a" in s.logs));
  });
});

describe("sleeper", () => {
  it("tidur → bangun manual / otomatis", () => {
    const s = defaultState();
    goSleep(s, 60);
    assert.equal(isSleeping(s), true);
    forceWake(s, "test");
    assert.equal(isSleeping(s), false);
    goSleep(s, 1);
    const nanti = new Date(Date.now() + 2 * 60_000);
    assert.equal(isSleeping(s, nanti), false); // kedaluwarsa → bangun
    assert.equal(s.sleepUntil, null);
  });
});
