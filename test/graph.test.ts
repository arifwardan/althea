// Graph LangGraph: plan→implement→review, loop fix, sinyal limit/batal, resume.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGraphTask, parseReview, type RunFn } from "../src/agent/graph.js";
import type { ClaudeResult } from "../src/claude.js";
import { defaultState } from "../src/state.js";
import { pushTask } from "../src/workflow.js";

const ok = (output: string): ClaudeResult =>
  ({ ok: true, output, hitLimit: false, retryAfterMs: null, cancelled: false });

function mock(responder: (prompt: string, calls: string[]) => ClaudeResult): { run: RunFn; calls: string[] } {
  const calls: string[] = [];
  const run: RunFn = async (prompt) => {
    calls.push(prompt);
    return responder(prompt, calls);
  };
  return { run, calls };
}

const byNode = (calls: string[]) => ({
  plan: calls.filter((p) => p.startsWith("Kamu perencana")).length,
  implement: calls.filter((p) => p.startsWith("Kamu pelaksana")).length,
  review: calls.filter((p) => p.startsWith("Kamu reviewer")).length,
});

function freshTask() {
  return pushTask(defaultState(), "T", "kerjakan X");
}

describe("runGraphTask", () => {
  it("happy path: plan→implement→review APPROVED", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) =>
      ok(p.startsWith("Kamu perencana") ? "1. a" : p.startsWith("Kamu pelaksana") ? "selesai" : "APPROVED"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.approved, true);
    assert.equal(g.ok, true);
    assert.equal(g.outputs.length, 3);
    assert.deepEqual(byNode(calls), { plan: 1, implement: 1, review: 1 });
    assert.equal(t.graph?.plan, "1. a");
  });

  it("FEEDBACK 2x lalu APPROVED → 3x implement", async () => {
    const t = freshTask();
    let reviews = 0;
    const { run, calls } = mock((p) => {
      if (!p.startsWith("Kamu reviewer")) return ok("x");
      reviews += 1;
      return ok(reviews < 3 ? `FEEDBACK: kurang ${reviews}` : "APPROVED");
    });
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.approved, true);
    assert.deepEqual(byNode(calls), { plan: 1, implement: 3, review: 3 });
    assert.equal(t.graph?.iteration, 2);
  });

  it("selalu FEEDBACK + maxRounds 1 → tak lolos", async () => {
    const t = freshTask();
    const { run } = mock((p) => ok(p.startsWith("Kamu reviewer") ? "FEEDBACK: jelek" : "x"));
    const g = await runGraphTask({ task: t, maxRounds: 1, run });
    assert.equal(g.approved, false);
    assert.equal(g.ok, false);
  });

  it("hitLimit di tengah → sinyal + plan tersimpan (resume)", async () => {
    const t = freshTask();
    const { run } = mock((p) =>
      p.startsWith("Kamu pelaksana")
        ? { ...ok(""), ok: false, hitLimit: true, retryAfterMs: 1234 }
        : ok("rencana"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.hitLimit, true);
    assert.equal(g.retryAfterMs, 1234);
    assert.equal(t.graph?.plan, "rencana");
  });

  it("cancelled → sinyal batal", async () => {
    const t = freshTask();
    const { run } = mock(() => ({ ...ok(""), ok: false, cancelled: true }));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.cancelled, true);
  });

  it("resume: plan+feedback dipakai, node plan dilewati", async () => {
    const t = freshTask();
    t.graph = { plan: "P-lama", iteration: 1, feedback: "F-lama" };
    const { run, calls } = mock((p) => ok(p.startsWith("Kamu reviewer") ? "APPROVED" : "kerja"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.approved, true);
    assert.equal(byNode(calls).plan, 0);
    const impl = calls.find((p) => p.startsWith("Kamu pelaksana")) as string;
    assert.match(impl, /P-lama/);
    assert.match(impl, /F-lama/);
  });
});

describe("inputChars", () => {
  it("graph menghitung total karakter prompt node", async () => {
    const t = freshTask();
    const { run } = mock((p) => ok(p.startsWith("Kamu reviewer") ? "APPROVED" : "x"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.ok(g.inputChars > 100);
  });
});

describe("parseReview", () => {
  it("APPROVED / FEEDBACK / polos", () => {
    assert.deepEqual(parseReview("  APPROVED\n"), { verdict: "approve", feedback: null });
    assert.deepEqual(parseReview("FEEDBACK: 1. a\n2. b"), { verdict: "fix", feedback: "1. a\n2. b" });
    assert.equal(parseReview("oke sih").verdict, "fix");
  });
});
