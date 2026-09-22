// Kontrol otak via dashboard: model + effort untuk `muse exec`.
// Berlaku untuk spawn berikutnya (override dashboard > default env > default CLI).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BRAIN_EFFORTS, normalizeEffort, normalizeModel,
  effectiveBrain, brainArgs, setBrainOverride, spawnErrorNote,
} from "../src/claude.js";
import { loadState } from "../src/state.js";

const ENV = { bin: "muse", subcommand: "exec", model: "", effort: "" };

describe("validasi model/effort", () => {
  it("effort hanya menerima 8 tier (case-insensitive), selain itu default", () => {
    assert.deepEqual([...BRAIN_EFFORTS],
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal(normalizeEffort("high"), "high");
    assert.equal(normalizeEffort("XHigh"), "xhigh");
    assert.equal(normalizeEffort(""), "");
    assert.equal(normalizeEffort("turbo"), "");
    assert.equal(normalizeEffort(42), "");
  });
  it("model di-trim dan dibatasi 120 karakter", () => {
    assert.equal(normalizeModel("  m1  "), "m1");
    assert.equal(normalizeModel("x".repeat(200)).length, 120);
    assert.equal(normalizeModel(null), "");
  });
});

describe("preseden: dashboard > env > default CLI", () => {
  it("override dashboard menang atas env", () => {
    const b = effectiveBrain(
      { model: "m-dash", effort: "low" },
      { ...ENV, model: "m-env", effort: "high" },
    );
    assert.equal(b.model, "m-dash");
    assert.equal(b.effort, "low");
    assert.equal(b.modelSource, "dashboard");
    assert.equal(b.effortSource, "dashboard");
  });
  it("override kosong → jatuh ke env → default CLI", () => {
    const b = effectiveBrain({ model: "", effort: "" }, { ...ENV, model: "", effort: "" });
    assert.equal(b.model, "");
    assert.equal(b.effort, "");
    assert.equal(b.modelSource, "cli-default");
    assert.equal(b.effortSource, "cli-default");
    const c = effectiveBrain({ model: "", effort: "" }, { ...ENV, model: "m-env", effort: "" });
    assert.equal(c.model, "m-env");
    assert.equal(c.modelSource, "env");
  });
  it("setBrainOverride mengubah spawn berikutnya (modul)", () => {
    try {
      setBrainOverride({ model: "m-baru", effort: "ultra" });
      const b = effectiveBrain(undefined, ENV);
      assert.equal(b.model, "m-baru");
      assert.equal(b.effort, "ultra");
    } finally {
      setBrainOverride({ model: "", effort: "" });
    }
  });
});

describe("argumen spawn", () => {
  it("gaya exec: flags model/effort sebelum prompt", () => {
    const b = effectiveBrain({ model: "m1", effort: "high" }, ENV);
    assert.deepEqual(brainArgs("KERJAKAN", b),
      ["exec", "--model", "m1", "--reasoning-effort", "high", "KERJAKAN"]);
  });
  it("gaya exec: default yang kosong dihilangkan", () => {
    const b = effectiveBrain({ model: "", effort: "" }, ENV);
    assert.deepEqual(brainArgs("KERJAKAN", b), ["exec", "KERJAKAN"]);
  });
  it("gaya lama (subcommand kosong): tetap -p tanpa flags", () => {
    const b = effectiveBrain(
      { model: "m1", effort: "high" },
      { ...ENV, bin: "Muse", subcommand: "" },
    );
    assert.deepEqual(brainArgs("KERJAKAN", b), ["-p", "KERJAKAN"]);
  });
});

describe("pesan spawn gagal", () => {
  it("ENOENT → sebut perintah + suruh cek BRAIN_BIN", () => {
    const err = Object.assign(new Error("spawn xxx ENOENT"), { code: "ENOENT" });
    const note = spawnErrorNote("xxx", err);
    assert.match(note, /otak tidak ditemukan/);
    assert.match(note, /"xxx"/);
    assert.match(note, /BRAIN_BIN/);
  });
  it("error lain → pesan generik", () => {
    assert.match(spawnErrorNote("b", new Error("boom")), /spawn error/);
  });
});

describe("migrasi state lama", () => {
  it("state tanpa field brain dapat default kosong", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-brain-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({ version: 1, stack: [] }));
    const s = loadState(p);
    assert.deepEqual(s.brain, { model: "", effort: "" });
  });
});
