// Tanpa cooldown kuota: limit provider langsung menggagalkan tugas.
// State lama (waiting_quota / limitCooldownUntil / quotaHistory) dimigrasi
// agar langsung antre lagi. Jalankan: npm test (tsx + node:test).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, loadState, saveState } from "../src/state.js";
import { pushTask, peek, cancelTask, stackSummary } from "../src/workflow.js";
import { buildReport } from "../src/report.js";

describe("tanpa cooldown kuota", () => {
  it("defaultState tak punya field kuota", () => {
    const s = defaultState();
    assert.ok(!("limitCooldownUntil" in s));
    assert.ok(!("lastReset" in s));
    assert.ok(!("quotaHistory" in s));
  });
  it("tak ada status waiting_quota di jalur aktif", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas A", "kerjakan A");
    assert.equal(t.status, "queued");
    assert.equal(peek(s)?.id, t.id);
    assert.match(stackSummary(s), /queued/);
    assert.doesNotMatch(stackSummary(s), /waiting_quota/);
    assert.equal(cancelTask(s, t.id), true);
    assert.equal(t.status, "failed");
  });
  it("laporan tak menyinggung cooldown/reset kuota", () => {
    const s = defaultState();
    pushTask(s, "tugas A", "kerjakan A");
    const r = buildReport(s);
    assert.doesNotMatch(r, /cooldown/i);
    assert.doesNotMatch(r, /quota/i);
    assert.doesNotMatch(r, /reset/i);
  });
});

describe("migrasi state lama ber-cooldown", () => {
  it("waiting_quota → queued, field kuota dibuang", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-quota-"));
    const p = join(dir, "state.json");
    const legacy = {
      version: 1,
      stack: [{
        id: "t_lama", title: "tugas lama", prompt: "kerjakan",
        status: "waiting_quota", attempts: 1, note: "",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }],
      limitCooldownUntil: new Date(Date.now() + 3600_000).toISOString(),
      lastReset: null,
      quotaHistory: [{
        taskId: "t_lama", title: "tugas lama", hitAt: new Date().toISOString(),
        resumeAt: null, waitMs: null, until: new Date().toISOString(),
      }],
    };
    writeFileSync(p, JSON.stringify(legacy));
    const s = loadState(p);
    assert.equal(s.stack[0].status, "queued"); // langsung antre lagi, tak ditahan
    assert.equal(peek(s)?.id, "t_lama");
    assert.ok(!("limitCooldownUntil" in s));
    assert.ok(!("lastReset" in s));
    assert.ok(!("quotaHistory" in s));
    // Tersimpan bersih saat save berikutnya.
    saveState(p, s);
    const raw = JSON.parse(readFileSync(p, "utf8"));
    assert.ok(!("limitCooldownUntil" in raw));
    assert.ok(!("quotaHistory" in raw));
  });
  it("state lama tanpa field kuota tetap valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-quota-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({ version: 1, stack: [] }));
    const s = loadState(p);
    assert.equal(s.stack.length, 0);
    assert.ok(!("limitCooldownUntil" in s));
  });
});
