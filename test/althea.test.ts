// Kontrak inti Althea: deteksi limit (tanpa cooldown), approval, stack LIFO, tidur.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultState, appendLog, appendActivity } from "../src/state.js";
import { pushTask, peek, markDone, requestApproval, resolveApproval, cancelTask, correctTask, shouldApplyRunResult, deleteTask, requeueTask, parseIzinRequest, noteTimeout, stackSummary } from "../src/workflow.js";
import { killRunning } from "../src/claude.js";
import { detectLimit, parseRetryAfter, limitHit } from "../src/claude.js";
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
  it("limitHit: hanya error asli atau run gagal + pesan limit", () => {
    // Error asli CLI/API → limit, walau exit 0 (CLI melaporkan error sendiri).
    assert.equal(limitHit(0, "usage limit reached, try again in 5 minutes", ""), true);
    assert.equal(limitHit(1, "quota exceeded for this period", ""), true);
    // Run SUKSES (exit 0) tapi jawaban AI menyebut quota → BUKAN limit.
    assert.equal(limitHit(0, "", "I updated the quota config; tests passed"), false);
    // Run gagal + pesan limit di output → limit.
    assert.equal(limitHit(1, "", "Error: 429 Too Many Requests"), true);
    // Run gagal tanpa pesan limit → gagal biasa.
    assert.equal(limitHit(1, "", "done: 3 files changed"), false);
  });
  it("parseRetryAfter membaca 'try again in N unit' (untuk pesan saran tunggu)", () => {
    assert.equal(parseRetryAfter("try again in 5 minutes"), 5 * 60_000);
    assert.equal(parseRetryAfter("Try again in 2 hours"), 2 * 3_600_000);
    assert.equal(parseRetryAfter("try again in 30 detik"), 30_000);
    assert.equal(parseRetryAfter("limit reached"), null);
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
    assert.match(stackSummary(defaultState()), /empty/);
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

describe("correctTask (koreksi mid-run)", () => {
  it("running → prompt ditempel koreksi + graph dibuang + kembali queued", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "prompt awal");
    t.status = "running";
    t.graph = { plan: "rencana lama", iteration: 2 };
    assert.equal(correctTask(s, t.id, "pakai Elysia"), true);
    assert.equal(t.status, "queued");
    assert.match(t.prompt, /prompt awal/);
    assert.match(t.prompt, /Admin correction: pakai Elysia/);
    assert.equal(t.graph, undefined);
    assert.equal(peek(s)?.id, t.id); // langsung bisa dikerjakan lagi
  });
  it("queued ikut bisa dikoreksi; attempts tak berubah", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    t.attempts = 2;
    assert.equal(correctTask(s, t.id, "  tambah tombol cetak  "), true);
    assert.equal(t.status, "queued");
    assert.equal(t.attempts, 2);
    assert.match(t.prompt, /tambah tombol cetak/);
  });
  it("done/failed/tak dikenal/koreksi kosong → false, prompt utuh", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "prompt awal");
    markDone(s, t.id);
    assert.equal(correctTask(s, t.id, "ubah"), false);
    assert.equal(correctTask(s, "t_takada", "ubah"), false);
    const q = pushTask(s, "Y", "prompt awal");
    assert.equal(correctTask(s, q.id, "   "), false);
    assert.equal(q.prompt, "prompt awal");
  });
});

describe("shouldApplyRunResult (hasil run basi dibuang)", () => {
  it("running → terapkan; queued/failed (correct/cancel mid-run) → buang", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    t.status = "running";
    assert.equal(shouldApplyRunResult(t), true);
    t.status = "queued"; // correctTask saat run berjalan
    assert.equal(shouldApplyRunResult(t), false);
    t.status = "failed"; // cancelTask saat run berjalan
    assert.equal(shouldApplyRunResult(t), false);
  });
});

describe("deleteTask (hapus permanen)", () => {
  it("tugas hilang dari stack + approval/log/aktivitas ikut bersih", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    requestApproval(s, t.id, "izin?");
    appendLog(s, t.id, "baris log");
    appendActivity(s, t.id, "tool", "bash");
    assert.equal(deleteTask(s, t.id), true);
    assert.equal(s.stack.length, 0);
    assert.equal(s.approvals.length, 0);
    assert.ok(!(t.id in s.logs));
    assert.ok(!(t.id in s.activity));
    assert.equal(peek(s), undefined);
  });
  it("tugas lain tak tersentuh; id tak dikenal → false", () => {
    const s = defaultState();
    const a = pushTask(s, "A", "p");
    const b = pushTask(s, "B", "p");
    assert.equal(deleteTask(s, a.id), true);
    assert.equal(s.stack.length, 1);
    assert.equal(s.stack[0].id, b.id);
    assert.equal(deleteTask(s, "t_takada"), false);
  });
});

describe("requeueTask (jalankan ulang tanpa form)", () => {
  it("done/failed → queued, prompt dan graph utuh", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "prompt awal");
    t.graph = { plan: "rencana", iteration: 1 };
    markDone(s, t.id);
    assert.equal(requeueTask(s, t.id), true);
    assert.equal(t.status, "queued");
    assert.equal(t.prompt, "prompt awal");
    assert.deepEqual(t.graph, { plan: "rencana", iteration: 1 });
    assert.equal(peek(s)?.id, t.id);
  });
  it("running/queued/waiting_approval/tak dikenal → false", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    assert.equal(requeueTask(s, t.id), false); // queued
    t.status = "running";
    assert.equal(requeueTask(s, t.id), false);
    requestApproval(s, t.id, "izin?");
    assert.equal(requeueTask(s, t.id), false);
    assert.equal(requeueTask(s, "t_takada"), false);
  });
});

describe("parseIzinRequest (approval prompt toleran)", () => {
  it("menangkap varian penulisan AI", () => {
    assert.equal(parseIzinRequest("IZIN: boleh deploy?"), "boleh deploy?");
    assert.equal(parseIzinRequest("kerja selesai\n**IZIN:** hapus folder X?"), "hapus folder X?");
    assert.equal(parseIzinRequest("**IZIN**: hapus folder X?"), "hapus folder X?");
    assert.equal(parseIzinRequest("  IZIN : lanjut?"), "lanjut?");
    assert.equal(parseIzinRequest("Izin: restart service?"), "restart service?");
  });
  it("prosa biasa / kosong → null", () => {
    assert.equal(parseIzinRequest("done: 3 files changed, tests passed"), null);
    assert.equal(parseIzinRequest("IZIN:"), null);
    assert.equal(parseIzinRequest(""), null);
    assert.equal(parseIzinRequest("perizinan sudah diurus admin"), null);
  });
});

describe("noteTimeout (retry otomatis)", () => {
  it("attempts < maks → queued lagi", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    t.status = "running";
    t.attempts = 1;
    assert.equal(noteTimeout(s, t.id, 3), "retry");
    assert.equal(s.stack[0].status, "queued");
  });
  it("attempts capai maks → failed + saran naikkan timeout", () => {
    const s = defaultState();
    const t = pushTask(s, "X", "p");
    t.status = "running";
    t.attempts = 3;
    assert.equal(noteTimeout(s, t.id, 3), "fail");
    assert.equal(s.stack[0].status, "failed");
    assert.match(s.stack[0].note || "", /CLAUDE_TIMEOUT_SECONDS/);
  });
  it("id tak dikenal → fail", () => {
    assert.equal(noteTimeout(defaultState(), "t_takada", 3), "fail");
  });
});

describe("appendActivity", () => {
  it("simpan + pangkas 120 entri & 5 tugas", () => {
    const s = defaultState();
    appendActivity(s, "a", "tool", "bash …");
    assert.equal(s.activity.a.length, 1);
    assert.match(s.activity.a[0].t, /^\d\d:\d\d:\d\d$/);
    for (let i = 0; i < 130; i++) appendActivity(s, "a", "file", `ubah: f${i}`);
    assert.equal(s.activity.a.length, 120);
    for (const id of ["b", "c", "d", "e", "f"]) appendActivity(s, id, "tool", "x");
    assert.equal(Object.keys(s.activity).length, 5);
    assert.ok(!s.activity.a);
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
