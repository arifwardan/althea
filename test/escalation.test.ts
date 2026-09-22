// Aturan eskalasi: web 3 mnt → telegram 3 mnt → putuskan sendiri.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../src/state.js";
import { pushTask, requestApproval } from "../src/workflow.js";
import { autoDecide, processEscalations, stageRemainingMs } from "../src/escalation.js";

const CFG = { webMinutes: 3, tgMinutes: 3, autodecide: true };
const MIN = 60_000;

function pending(question = "boleh lanjut build?"): { s: ReturnType<typeof defaultState>; id: string } {
  const s = defaultState();
  const t = pushTask(s, "T", "prompt");
  requestApproval(s, t.id, question);
  return { s, id: t.id };
}

describe("autoDecide", () => {
  it("destruktif → tolak", () => {
    for (const q of ["boleh hapus database produksi?", "jalankan rm -rf /tmp/x", "deploy produksi sekarang?"]) {
      const d = autoDecide(q);
      assert.equal(d.ok, false, q);
      assert.match(d.reason, /otomatis/);
    }
  });
  it("non-destruktif → setuju", () => {
    const d = autoDecide("boleh lanjut build staging?");
    assert.equal(d.ok, true);
  });
});

describe("processEscalations", () => {
  it("web segar → diam; lewat 3 mnt → to-telegram", () => {
    const { s, id } = pending();
    const t0 = Date.parse(s.approvals[0].createdAt);
    assert.deepEqual(processEscalations(s, t0 + MIN, CFG), []);
    const acts = processEscalations(s, t0 + 3 * MIN + 1000, CFG);
    assert.deepEqual(acts, [{ type: "to-telegram", id }]);
    assert.equal(s.approvals[0].stage, "telegram");
    assert.ok(s.approvals[0].escalatedAt);
  });
  it("telegram lewat 3 mnt → auto-decide", () => {
    const { s, id } = pending();
    const t0 = Date.parse(s.approvals[0].createdAt);
    processEscalations(s, t0 + 4 * MIN, CFG); // → telegram
    const t1 = Date.parse(s.approvals[0].escalatedAt as string);
    assert.deepEqual(processEscalations(s, t1 + MIN, CFG), []);
    const acts = processEscalations(s, t1 + 3 * MIN + 1000, CFG);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].type, "auto-decide");
    assert.equal((acts[0] as { id: string }).id, id);
  });
  it("autodecide mati → telegram menunggu selamanya", () => {
    const { s } = pending();
    const t0 = Date.parse(s.approvals[0].createdAt);
    processEscalations(s, t0 + 4 * MIN, CFG);
    const t1 = Date.parse(s.approvals[0].escalatedAt as string);
    assert.deepEqual(processEscalations(s, t1 + 60 * MIN, { ...CFG, autodecide: false }), []);
  });
  it("stageRemainingMs menghitung sisa waktu", () => {
    const { s } = pending();
    const t0 = Date.parse(s.approvals[0].createdAt);
    assert.ok(stageRemainingMs(s.approvals[0], t0 + MIN, CFG) > 0);
    assert.ok(stageRemainingMs(s.approvals[0], t0 + 5 * MIN, CFG) <= 0);
  });
});
