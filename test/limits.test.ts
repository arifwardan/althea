// Batas eksekusi via dashboard: timeout per-spawn untuk `muse exec`.
// Berlaku untuk spawn berikutnya (override dashboard > env > default 1800).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TIMEOUT_MIN_SECONDS, TIMEOUT_MAX_SECONDS, TIMEOUT_DEFAULT_SECONDS,
  parseTimeoutSeconds, effectiveTimeoutSeconds, setTimeoutOverride,
} from "../src/claude.js";
import { loadState } from "../src/state.js";

describe("validasi timeout", () => {
  it("batas wajar 60–86400 detik", () => {
    assert.equal(TIMEOUT_MIN_SECONDS, 60);
    assert.equal(TIMEOUT_MAX_SECONDS, 86400);
    assert.equal(TIMEOUT_DEFAULT_SECONDS, 1800);
  });
  it("angka valid dalam rentang diterima", () => {
    assert.equal(parseTimeoutSeconds(60), 60);
    assert.equal(parseTimeoutSeconds(3600), 3600);
    assert.equal(parseTimeoutSeconds(86400), 86400);
    assert.equal(parseTimeoutSeconds(" 1800 "), 1800);
  });
  it("0/kosong/absen = kembali ke default", () => {
    assert.equal(parseTimeoutSeconds(0), 0);
    assert.equal(parseTimeoutSeconds(""), 0);
    assert.equal(parseTimeoutSeconds(null), 0);
    assert.equal(parseTimeoutSeconds(undefined), 0);
  });
  it("di luar rentang / bukan bilangan bulat / sampah → invalid", () => {
    assert.equal(parseTimeoutSeconds(30), null);
    assert.equal(parseTimeoutSeconds(-5), null);
    assert.equal(parseTimeoutSeconds(999999), null);
    assert.equal(parseTimeoutSeconds(90.5), null);
    assert.equal(parseTimeoutSeconds("sejam"), null);
    assert.equal(parseTimeoutSeconds(NaN), null);
  });
});

describe("preseden: dashboard > env > default", () => {
  it("override dashboard menang atas env", () => {
    const t = effectiveTimeoutSeconds(3600, 1800);
    assert.equal(t.seconds, 3600);
    assert.equal(t.source, "dashboard");
  });
  it("override 0 → jatuh ke env → default 1800", () => {
    assert.deepEqual(effectiveTimeoutSeconds(0, 900), { seconds: 900, source: "env" });
    assert.deepEqual(effectiveTimeoutSeconds(0, 0), { seconds: 1800, source: "default" });
  });
  it("setTimeoutOverride mengubah spawn berikutnya (modul)", () => {
    try {
      setTimeoutOverride(7200);
      const t = effectiveTimeoutSeconds(undefined, 1800);
      assert.equal(t.seconds, 7200);
      assert.equal(t.source, "dashboard");
    } finally {
      setTimeoutOverride(0);
    }
  });
  it("setTimeoutOverride invalid → jatuh ke default, tak pernah meledak", () => {
    try {
      setTimeoutOverride("ngawur");
      const t = effectiveTimeoutSeconds(undefined, 1800);
      assert.equal(t.seconds, 1800);
      assert.equal(t.source, "env");
    } finally {
      setTimeoutOverride(0);
    }
  });
});

describe("migrasi state lama", () => {
  it("state tanpa field limits dapat default 0 (= ikut env)", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-limits-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({ version: 1, stack: [] }));
    const s = loadState(p);
    assert.deepEqual(s.limits, { timeoutSeconds: 0 });
  });
  it("nilai rusak dibersihkan ke 0, nilai valid dipertahankan", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-limits-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, limits: { timeoutSeconds: -10 } }));
    assert.equal(loadState(bad).limits.timeoutSeconds, 0);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ version: 1, limits: { timeoutSeconds: 3600 } }));
    assert.equal(loadState(good).limits.timeoutSeconds, 3600);
  });
});
