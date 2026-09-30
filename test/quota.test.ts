// FR-4 kuota ±5 jam: waiting_quota per-run + riwayat kuota + resume otomatis.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultState, loadState } from "../src/state.js";
import {
  pushTask, peek, cancelTask, markWaitingQuota, resumeQuotaTasks, stackSummary,
} from "../src/workflow.js";

describe("markWaitingQuota (FR-4.1)", () => {
  it("tugas → waiting_quota + episode tercatat (estimasi ikut)", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas A", "kerjakan A");
    const until = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(markWaitingQuota(s, t.id, until), true);
    assert.equal(t.status, "waiting_quota");
    assert.equal(s.quotaHistory.length, 1);
    const e = s.quotaHistory[0];
    assert.equal(e.taskId, t.id);
    assert.equal(e.title, "tugas A");
    assert.equal(e.until, until);
    assert.equal(e.resumeAt, null);
    assert.equal(e.waitMs, null);
    assert.ok(Date.parse(e.hitAt) > 0);
  });
  it("id tak dikenal → false, tanpa riwayat", () => {
    const s = defaultState();
    assert.equal(markWaitingQuota(s, "t_takada", new Date().toISOString()), false);
    assert.equal(s.quotaHistory.length, 0);
  });
  it("riwayat dipangkas ke 50 terakhir", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas B", "kerjakan B");
    const until = new Date().toISOString();
    for (let i = 0; i < 55; i++) markWaitingQuota(s, t.id, until);
    assert.equal(s.quotaHistory.length, 50);
  });
});

describe("resumeQuotaTasks (FR-4.2)", () => {
  it("waiting_quota → queued + episode ditutup (durasi jeda terisi)", () => {
    const s = defaultState();
    const a = pushTask(s, "tugas A", "kerjakan A");
    const b = pushTask(s, "tugas B", "kerjakan B");
    markWaitingQuota(s, a.id, new Date().toISOString());
    const out = resumeQuotaTasks(s);
    assert.equal(out.length, 1);
    assert.equal(a.status, "queued");
    assert.equal(b.status, "queued"); // tak tersentuh (bukan waiting_quota)
    const e = s.quotaHistory[s.quotaHistory.length - 1];
    assert.ok(e.resumeAt !== null);
    assert.ok(typeof e.waitMs === "number" && (e.waitMs as number) >= 0);
  });
  it("tanpa waiting_quota → kosong, tanpa log bising", () => {
    const s = defaultState();
    pushTask(s, "tugas A", "kerjakan A");
    assert.deepEqual(resumeQuotaTasks(s), []);
  });
});

describe("interaksi status kuota", () => {
  it("peek melewati waiting_quota (ditahan sampai resume)", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas A", "kerjakan A");
    markWaitingQuota(s, t.id, new Date().toISOString());
    assert.equal(peek(s), undefined);
    resumeQuotaTasks(s);
    assert.equal(peek(s)?.id, t.id);
  });
  it("cancelTask bisa membatalkan waiting_quota + menutup episode", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas A", "kerjakan A");
    markWaitingQuota(s, t.id, new Date().toISOString());
    assert.equal(cancelTask(s, t.id), true);
    assert.equal(t.status, "failed");
    assert.ok(s.quotaHistory[0].resumeAt !== null);
  });
  it("stackSummary menghitung waiting_quota sebagai aktif", () => {
    const s = defaultState();
    const t = pushTask(s, "tugas A", "kerjakan A");
    markWaitingQuota(s, t.id, new Date().toISOString());
    assert.match(stackSummary(s), /waiting_quota/);
  });
});

describe("migrasi state lama (FR-4.4)", () => {
  it("state tanpa quotaHistory dapat []", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-quota-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({ version: 1, stack: [] }));
    assert.deepEqual(loadState(p).quotaHistory, []);
  });
  it("riwayat lama yang rusak dibersihkan, yang valid dipertahankan", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-quota-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, quotaHistory: "rusak" }));
    assert.deepEqual(loadState(bad).quotaHistory, []);
    const good = join(dir, "good.json");
    const ev = { taskId: "t_x", title: "A", hitAt: new Date().toISOString(), resumeAt: null, waitMs: null, until: new Date().toISOString() };
    writeFileSync(good, JSON.stringify({ version: 1, quotaHistory: [ev] }));
    assert.deepEqual(loadState(good).quotaHistory, [ev]);
  });
});
