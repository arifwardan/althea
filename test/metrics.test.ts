// Metrik laptop + status otak.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sampleCpu, getMetrics, checkBrain } from "../src/metrics.js";

describe("metrics", () => {
  it("sampleCpu 0–100", async () => {
    const v = await sampleCpu(50);
    assert.ok(v >= 0 && v <= 100);
  });
  it("getMetrics konsisten", async () => {
    const m = await getMetrics();
    assert.ok(m.memTotal > 0 && m.memFree <= m.memTotal);
    assert.ok(m.memUsedPercent >= 0 && m.memUsedPercent <= 100);
    assert.ok(m.cpuPercent >= 0 && m.cpuPercent <= 100);
    assert.ok(Array.isArray(m.net));
    assert.match(m.node, /^v/);
  });
});

describe("checkBrain", () => {
  it("bin ada → ok; bin fiktif → gagal", async () => {
    const ok = await checkBrain("node");
    assert.equal(ok.ok, true);
    assert.match(ok.version, /v\d/);
    const bad = await checkBrain("bin-yang-pasti-tidak-ada-xyz");
    assert.equal(bad.ok, false);
  });
});
