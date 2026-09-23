// Graph LangGraph: plan→implement→review, loop fix, sinyal limit/batal, resume.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGraphTask, parseReview, buildSlicePlan, runGateReview, buildImplementPrompt, type RunFn } from "../src/agent/graph.js";
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

  it("timedOut di tengah → sinyal timeout + plan tersimpan (retry)", async () => {
    const t = freshTask();
    const { run, calls } = mock((p) =>
      p.startsWith("Kamu pelaksana")
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
    assert.match(t.graph?.plan || "", /tanpa ronde LLM/);
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
    assert.match(p, /tanpa ronde LLM/);
    assert.ok([...p].length <= 100);
  });

  it("runGateReview: diff tak ternilai mesin diloloskan ke review manusia", () => {
    assert.equal(runGateReview("(bukan repo git — review dari daftar file)").verdict, "approve");
    assert.equal(runGateReview("(tanpa project — review dari output teks)").verdict, "approve");
    assert.equal(runGateReview("").verdict, "fix");
    assert.equal(runGateReview("diff --git a/f b/f\n+1").verdict, "approve");
    assert.equal(runGateReview("hanya teks tanpa perubahan").verdict, "fix");
  });
});

describe("FR-3.9: prompt implement hemat output + batas scope", () => {
  it("melarang dump file dan membatasi file yang diubah", () => {
    const p = buildImplementPrompt("kerjakan X", "1. a", null, 1);
    assert.match(p, /Jangan menempel seluruh isi file/);
    assert.match(p, /hanya file yang relevan/);
    assert.doesNotMatch(p, /Batas scope/);
    const scoped = buildImplementPrompt("kerjakan X", "1. a", null, 1, ["src/a.ts", "src/b.ts"]);
    assert.match(scoped, /Batas scope/);
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
    const impl = calls.find((p) => p.startsWith("Kamu pelaksana")) as string;
    return impl;
  }

  it("STANDARDS.md disuntik bila ada, absen bila tak ada", async () => {
    const s = defaultState();
    const t = pushTask(s, "T", "kerjakan X", "", "kasir");
    assert.doesNotMatch(await implementPrompt(t), /STANDARDS project/);
    writeFileSync(join(tmp, "kasir", "STANDARDS.md"), "TypeScript strict, tanpa stub.");
    const t2 = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const impl = await implementPrompt(t2);
    assert.match(impl, /STANDARDS project/);
    assert.match(impl, /tanpa stub/);
  });

  it("potongan PRD disuntik untuk fase eksekusi, bukan fase prd", async () => {
    writeFileSync(join(tmp, "kasir", "PRD.md"), "# PRD kasir\nfitur A, B, C.");
    const s = defaultState();
    const t = pushTask(s, "T", "kerjakan X", "", "kasir");
    t.phase = "fitur-1";
    assert.match(await implementPrompt(t), /RINGKASAN PRD/);
    const s2 = defaultState();
    const t2 = pushTask(s2, "T", "tulis PRD", "", "kasir");
    t2.phase = "prd";
    assert.doesNotMatch(await implementPrompt(t2), /RINGKASAN PRD/);
  });

  it("scope tugas diteruskan ke prompt coder + pushTask merapikannya", async () => {
    const t = pushTask(defaultState(), "T", "kerjakan X", "", "kasir", [" src/a.ts ", "", "src/b.ts"]);
    assert.deepEqual(t.scope, ["src/a.ts", "src/b.ts"]);
    assert.equal(pushTask(defaultState(), "T", "x").scope, undefined);
    const impl = await implementPrompt(t);
    assert.match(impl, /Batas scope/);
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
      ok(p.startsWith("Kamu reviewer") ? "APPROVED" : "kerja selesai"));
    const g = await runGraphTask({
      task, cwd: join(tmp, "kasir"), maxRounds: 2, run,
      planMode: "slice", reviewMode: "gate",
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, true);
    assert.match(g.outputs.join("\n"), /\[verify\]/);
    assert.match(g.outputs.join("\n"), /verifier lolos/);
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
  });

  it("check gagal → tak lolos tanpa bakar review LLM", async (t) => {
    if (!npmOk) t.skip("npm tak tersedia");
    writeFileSync(join(tmp, "kasir", "package.json"), JSON.stringify({
      scripts: { check: 'node -e "process.exit(1)"' },
    }));
    const task = pushTask(defaultState(), "T", "kerjakan X", "", "kasir");
    const { run, calls } = mock((p) =>
      ok(p.startsWith("Kamu reviewer") ? "APPROVED" : "kerja selesai"));
    const g = await runGraphTask({
      task, cwd: join(tmp, "kasir"), maxRounds: 1, run,
      planMode: "slice", reviewMode: "llm",
      getDiff: async () => "diff --git a/f b/f\n+1",
    });
    assert.equal(g.approved, false);
    assert.deepEqual(byNode(calls), { plan: 0, implement: 1, review: 0 });
    assert.match(g.outputs.join("\n"), /verifier gagal/);
    assert.match(task.graph?.feedback || "", /verifier gagal/);
  });
});
