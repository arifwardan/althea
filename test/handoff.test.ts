// Handoff antar-run: ringkasan pekerjaan + bagian prompt resume.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHandoff, buildResumeSection, HANDOFF_MAX_CHARS } from "../src/handoff.js";

describe("buildHandoff", () => {
  it("kumpulkan ringkasan tiap ronde implement (bukan plan/verify)", () => {
    const h = buildHandoff([
      "[plan]\n1. a",
      "[implement]\nselesai bagian auth",
      "[verify]\nverifier passed",
      "[implement]\nselesai bagian bayar",
    ]);
    assert.match(h, /Round 1: selesai bagian auth/);
    assert.match(h, /Round 2: selesai bagian bayar/);
    assert.doesNotMatch(h, /1\. a/);
    assert.doesNotMatch(h, /verifier passed/);
  });

  it("tanpa output implement → kosong", () => {
    assert.equal(buildHandoff([]), "");
    assert.equal(buildHandoff(["[plan]\n1. a", "[review]\nAPPROVED"]), "");
  });

  it("dibatasi maxChars — ekor (ringkasan terakhir) yang dipertahankan", () => {
    const h = buildHandoff([`[implement]\n${"x".repeat(5000)}`], 100);
    assert.ok(h.length <= 101, `panjang ${h.length}`);
    assert.match(h, /x+$/);
  });

  it("default maxChars = HANDOFF_MAX_CHARS", () => {
    const h = buildHandoff([`[implement]\n${"y".repeat(10_000)}`]);
    assert.ok(h.length <= HANDOFF_MAX_CHARS + 1);
  });
});

describe("buildResumeSection", () => {
  it("dua-duanya kosong/spasi → tanpa injeksi", () => {
    assert.equal(buildResumeSection("", "  "), "");
  });

  it("memuat penanda work-done, diff, dan instruksi lanjut", () => {
    const s = buildResumeSection("done: auth", "src/app.ts | 3 ++");
    assert.match(s, /WORK ALREADY DONE/);
    assert.match(s, /done: auth/);
    assert.match(s, /CHANGES ALREADY ON DISK/);
    assert.match(s, /src\/app\.ts/);
    assert.match(s, /do NOT start over/);
    assert.match(s, /continue, do NOT redo it/i);
  });

  it("tanpa handoff tetap menyuntik diff + instruksi lanjut", () => {
    const s = buildResumeSection("", "src/app.ts | 1 +");
    assert.doesNotMatch(s, /WORK ALREADY DONE/);
    assert.match(s, /CHANGES ALREADY ON DISK/);
    assert.match(s, /do NOT start over/);
  });

  it("tanpa diff tetap menyuntik handoff + instruksi lanjut", () => {
    const s = buildResumeSection("done: auth", "");
    assert.match(s, /WORK ALREADY DONE/);
    assert.doesNotMatch(s, /CHANGES ALREADY ON DISK/);
    assert.match(s, /do NOT start over/);
  });
});
