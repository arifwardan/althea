// Graph LangGraph: plan→implement→review, loop fix, sinyal limit/batal, resume.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGraphTask, parseReview, buildSlicePlan, runGateReview, buildImplementPrompt, buildReviewPrompt, type RunFn } from "../src/agent/graph.js";
import type { ClaudeResult } from "../src/claude.js";
import { defaultState } from "../src/state.js";
import { pushTask } from "../src/workflow.js";
import { config } from "../src/config.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { beforeEach, afterEach } from "node:test";

const ok = (output: string): ClaudeResult =>
  ({ ok: true, output, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false });

function mock(responder: (prompt: string, calls: string[]) => ClaudeResult): { run: RunFn; calls: string[] } {
  const calls: string[] = [];
  const run: RunFn = async (prompt) => {
    calls.push(prompt);
    return responder(prompt, calls);
  };
  return { run, calls };
}

const byNode = (calls: string[]) => ({
  plan: calls.filter((p) => p.startsWith("You are a planner")).length,
  implement: calls.filter((p) => p.startsWith("You are an implementer")).length,
  review: calls.filter((p) => p.startsWith("You are a strict reviewer")).length,
});

function freshTask() {
  return pushTask(defaultState(), "T", "kerjakan X");
}

describe("runGraphTask", () => {
  it("happy path: plan→implement→review APPROVED", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) =>
      ok(p.startsWith("You are a planner") ? "1. a" : p.startsWith("You are an implementer") ? "selesai" : "APPROVED"));
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
      if (!p.startsWith("You are a strict reviewer")) return ok("x");
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
    const { run } = mock((p) => ok(p.startsWith("You are a strict reviewer") ? "FEEDBACK: jelek" : "x"));
    const g = await runGraphTask({ task: t, maxRounds: 1, run });
    assert.equal(g.approved, false);
    assert.equal(g.ok, false);
  });

  it("hitLimit di tengah → sinyal + plan tersimpan (resume)", async () => {
    const t = freshTask();
    const { run } = mock((p) =>
      p.startsWith("You are an implementer")
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

  it("timedOut di tengah → sinyal timeout + plan tersimpan (retry)", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) =>
      p.startsWith("You are an implementer")
        ? { ...ok(""), ok: false, timedOut: true }
        : ok("rencana"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.timedOut, true);
    assert.equal(g.approved, false);
    assert.equal(byNode(calls).review, 0); // langsung abort, tak bakar ronde review
    assert.equal(t.graph?.plan, "rencana");
  });

  it("resume: plan+feedback dipakai, node plan dilewati", async () => {
    const t = freshTask();
    t.graph = { plan: "P-lama", iteration: 1, feedback: "F-lama" };
    const { run, calls } = mock((p) => ok(p.startsWith("You are a strict reviewer") ? "APPROVED" : "kerja"));
    const g = await runGraphTask({ task: t, maxRounds: 3, run });
    assert.equal(g.approved, true);
    assert.equal(byNode(calls).plan, 0);
    const impl = calls.find((p) => p.startsWith("You are an implementer")) as string;
    assert.match(impl, /P-lama/);
    assert.match(impl, /F-lama/);
  });
});

describe("inputChars", () => {
  it("graph menghitung total karakter prompt node", async () => {
    const t = freshTask();
    const { run } = mock((p) => ok(p.startsWith("You are a strict reviewer") ? "APPROVED" : "x"));
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

describe("plan slice + review gate (0 token LLM)", () => {
  it("slice+gate: tanpa panggilan plan/review LLM, approve bila diff ada", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) => ok("kerja selesai"));
    const g = await runGraphTask({
      task: t, maxRounds: 3, run, planMode: "slice", reviewMode: "gate",
      getDiff: async () => "diff --git a/f b/f\n+++ b/f\n+baris baru",
    });
    assert.equal(g.approved, true);
    assert.equal(g.reviewKind, "gate");
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
    assert.match(t.graph?.plan || "", /no LLM round/);
    assert.match(g.outputs.join("\n"), /\[plan-slice\]/);
    assert.match(g.outputs.join("\n"), /\[review-gate\]/);
  });

  it("gate menolak diff kosong → tak lolos tanpa bakar review LLM", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) => ok("kerja selesai"));
    const g = await runGraphTask({
      task: t, maxRounds: 1, run, planMode: "slice", reviewMode: "gate",
      getDiff: async () => "   ",
    });
    assert.equal(g.approved, false);
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
  });

  it("buildSlicePlan memotong instruksi panjang", () => {
    const p = buildSlicePlan("T", "baris1\nbaris2", 5);
    assert.match(p, /no LLM round/);
    assert.ok([...p].length <= 100);
  });

  it("runGateReview: diff tak ternilai mesin diloloskan ke review manusia", () => {
    assert.equal(runGateReview("(not a git repo — review from the file list)").verdict, "approve");
    assert.equal(runGateReview("(no project — review from text output)").verdict, "approve");
    assert.equal(runGateReview("").verdict, "fix");
    assert.equal(runGateReview("diff --git a/f b/f\n+1").verdict, "approve");
    assert.equal(runGateReview("hanya teks tanpa perubahan").verdict, "fix");
  });
});

describe("FR-3.9: prompt implement hemat output + batas scope", () => {
  it("melarang dump file dan membatasi file yang diubah", () => {
    const p = buildImplementPrompt("kerjakan X", "1. a", null, 1);
    assert.match(p, /Do not paste entire file contents/);
    assert.match(p, /only files relevant/);
    assert.doesNotMatch(p, /Scope limit/);
    const scoped = buildImplementPrompt("kerjakan X", "1. a", null, 1, ["src/a.ts", "src/b.ts"]);
    assert.match(scoped, /Scope limit/);
    assert.match(scoped, /src\/a\.ts/);
  });
});

describe("FR-3.11 + FR-3.8: STANDARDS dan potongan PRD disuntik", () => {
  let tmp = "";
  let prevWs = "";
  beforeEach(() => {
    prevWs = config.workspaceDir;
    tmp = mkdtempSync(join(tmpdir(), "althea-graph-ctx-"));
    config.workspaceDir = tmp;
    mkdirSync(join(tmp, "kasir"), { recursive: true });
  });
  afterEach(() => {
    config.workspaceDir = prevWs;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function implementPrompt(t: ReturnType<typeof freshTask>): Promise<string> {
    const { run, calls } = mock((p) => ok("kerja selesai"));
    await runGraphTask({
      task: t, maxRounds: 1, run, planMode: "slice", reviewMode: "gate", verify: false,
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    const impl = calls.find((p) => p.startsWith("You are an implementer")) as string;
    return impl;
  }

  it("STANDARDS.md disuntik bila ada, absen bila tak ada", async () => {
    const s = defaultState();
    const t = pushTask(s, "T", "kerjakan X", "", "kasir");
    assert.doesNotMatch(await implementPrompt(t), /PROJECT STANDARDS/);
    writeFileSync(join(tmp, "kasir", "STANDARDS.md"), "TypeScript strict, tanpa stub.");
    const t2 = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const impl = await implementPrompt(t2);
    assert.match(impl, /PROJECT STANDARDS/);
    assert.match(impl, /tanpa stub/);
  });

  it("potongan PRD disuntik untuk fase eksekusi, bukan fase prd", async () => {
    writeFileSync(join(tmp, "kasir", "PRD.md"), "# PRD kasir\nfitur A, B, C.");
    const s = defaultState();
    const t = pushTask(s, "T", "kerjakan X", "", "kasir");
    t.phase = "fitur-1";
    assert.match(await implementPrompt(t), /PRD SUMMARY/);
    const s2 = defaultState();
    const t2 = pushTask(s2, "T", "tulis PRD", "", "kasir");
    t2.phase = "prd";
    assert.doesNotMatch(await implementPrompt(t2), /PRD SUMMARY/);
  });

  it("scope tugas diteruskan ke prompt coder + pushTask merapikannya", async () => {
    const t = pushTask(defaultState(), "T", "kerjakan X", "", "kasir", [" src/a.ts ", "", "src/b.ts"]);
    assert.deepEqual(t.scope, ["src/a.ts", "src/b.ts"]);
    assert.equal(pushTask(defaultState(), "T", "x").scope, undefined);
    const impl = await implementPrompt(t);
    assert.match(impl, /Scope limit/);
    assert.match(impl, /src\/a\.ts/);
  });
});

describe("FR-3.10: verifier sebagai hard gate", () => {
  let tmp = "";
  let prevWs = "";
  const npmOk = (() => {
    try {
      execFileSync("npm", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  beforeEach(() => {
    prevWs = config.workspaceDir;
    tmp = mkdtempSync(join(tmpdir(), "althea-graph-verify-"));
    config.workspaceDir = tmp;
    mkdirSync(join(tmp, "kasir"), { recursive: true });
  });
  afterEach(() => {
    config.workspaceDir = prevWs;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("check lolos → approve + ada output [verify]", async (t) => {
    if (!npmOk) t.skip("npm tak tersedia");
    writeFileSync(join(tmp, "kasir", "package.json"), JSON.stringify({
      scripts: { check: 'node -e "process.exit(0)"' },
    }));
    const task = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const { run, calls } = mock((p) =>
      ok(p.startsWith("You are a strict reviewer") ? "APPROVED" : "kerja selesai"));
    const g = await runGraphTask({
      task, cwd: join(tmp, "kasir"), maxRounds: 2, run,
      planMode: "slice", reviewMode: "gate",
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, true);
    assert.match(g.outputs.join("\n"), /\[verify\]/);
    assert.match(g.outputs.join("\n"), /verifier passed/);
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
  });

  it("check gagal → tak lolos tanpa bakar review LLM", async (t) => {
    if (!npmOk) t.skip("npm tak tersedia");
    writeFileSync(join(tmp, "kasir", "package.json"), JSON.stringify({
      scripts: { check: 'node -e "process.exit(1)"' },
    }));
    const task = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const { run, calls } = mock((p) =>
      ok(p.startsWith("You are a strict reviewer") ? "APPROVED" : "kerja selesai"));
    const g = await runGraphTask({
      task, cwd: join(tmp, "kasir"), maxRounds: 1, run,
      planMode: "slice", reviewMode: "llm",
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, false);
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
    assert.match(g.outputs.join("\n"), /verifier failed/);
    assert.match(task.graph?.feedback || "", /verifier failed/);
  });

  it("ringkasan verifier diteruskan ke prompt reviewer LLM", async (t) => {
    if (!npmOk) t.skip("npm tak tersedia");
    writeFileSync(join(tmp, "kasir", "package.json"), JSON.stringify({
      scripts: { check: 'node -e "process.exit(0)"' },
    }));
    const task = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const { run, calls } = mock((p) =>
      ok(p.startsWith("You are a strict reviewer") ? "APPROVED" : "kerja selesai"));
    const g = await runGraphTask({
      task, cwd: join(tmp, "kasir"), maxRounds: 2, run,
      planMode: "slice", reviewMode: "llm",
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, true);
    const review = calls.find((p) => p.startsWith("You are a strict reviewer")) as string;
    assert.match(review, /Machine verifier result/);
    assert.match(review, /verifier passed: check/);
  });
});

describe("review rilis: brief scope + bukti verifier", () => {
  it("buildReviewPrompt default tak berubah (tanpa Scope/Verifier)", () => {
    const p = buildReviewPrompt("1. a", "diff --git a/f b/f\n+1");
    assert.match(p, /strict reviewer/);
    assert.doesNotMatch(p, /Scope:/);
    assert.doesNotMatch(p, /Machine verifier result/);
  });

  it("brief + ringkasan verifier masuk ke prompt reviewer", () => {
    const p = buildReviewPrompt("1. a", "diff", {
      brief: "RELEASE-SCOPE", verifySummary: "[verify]\nverifier passed: build",
    });
    assert.match(p, /Scope:\nRELEASE-SCOPE/);
    assert.match(p, /Machine verifier result/);
    assert.match(p, /verifier passed: build/);
  });

  it("reviewBrief diteruskan end-to-end ke node reviewer", async () => {
    const decide = (p: string) =>
      ok(p.startsWith("You are a strict reviewer") ? (p.includes("RELEASE-SCOPE") ? "APPROVED" : "FEEDBACK: no scope") : "kerja");
    const t = freshTask();
    const m1 = mock(decide);
    const g = await runGraphTask({
      task: t, maxRounds: 1, run: m1.run, reviewBrief: "RELEASE-SCOPE",
      verify: false, getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, true);
    const t2 = freshTask();
    const m2 = mock(decide);
    const g2 = await runGraphTask({
      task: t2, maxRounds: 1, run: m2.run, verify: false,
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g2.approved, false);
  });
});
