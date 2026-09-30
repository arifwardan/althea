import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../src/state.js";
import { buildAskPrompt } from "../src/workflow.js";
import { matchDestructive } from "../src/escalation.js";
import { handleCommand } from "../src/telegram.js";

const noop = () => {};

describe("/prompt intake gate", () => {
  it("clean prompt is pushed to the stack", async () => {
    const s = defaultState();
    const out = await handleCommand(s, 1, "/prompt buatkan aplikasi kasir sederhana", noop);
    assert.match(out, /Queued:/);
    assert.equal(s.stack.length, 1);
    assert.equal(s.stack[0].askOnly, undefined);
  });
  it("empty /prompt shows format", async () => {
    const s = defaultState();
    const out = await handleCommand(s, 1, "/prompt", noop);
    assert.match(out, /Usage: \/prompt/);
    assert.equal(s.stack.length, 0);
  });
  it("destructive prompts are rejected, nothing pushed", async () => {
    const bad = [
      "/prompt hapus project althea",
      "/prompt uninstall aplikasi kasir di laptop",
      "/prompt drop table users",
      "/prompt delete all files",
      "/prompt shutdown server sekarang",
    ];
    for (const q of bad) {
      const s = defaultState();
      const out = await handleCommand(s, 1, q, noop);
      assert.match(out, /destructive prompt/, q);
      assert.equal(s.stack.length, 0, q);
    }
  });
});

describe("/ask read-only queue", () => {
  it("question is queued with askOnly flag", async () => {
    const s = defaultState();
    const out = await handleCommand(s, 1, "/ask apa itu pipeline?", noop);
    assert.match(out, /Queued/);
    assert.equal(s.stack.length, 1);
    assert.equal(s.stack[0].askOnly, true);
    assert.equal(s.stack[0].prompt, "apa itu pipeline?");
  });
  it("empty /ask shows format", async () => {
    const s = defaultState();
    const out = await handleCommand(s, 1, "/ask", noop);
    assert.match(out, /Usage: \/ask/);
    assert.equal(s.stack.length, 0);
  });
  it("buildAskPrompt forbids changes and demands English", () => {
    const p = buildAskPrompt("apa itu pipeline?");
    assert.match(p, /READ-ONLY/);
    assert.match(p, /Strictly forbidden/);
    assert.match(p, /in English/);
    assert.match(p, /Question: apa itu pipeline\?/);
  });
  it("matchDestructive spots new risky patterns", () => {
    for (const q of ["hapus project althea", "uninstall aplikasi kasir", "drop table users", "factory reset laptop"]) {
      assert.ok(matchDestructive(q), q);
    }
    assert.equal(matchDestructive("buatkan aplikasi kasir sederhana"), null);
  });
});
