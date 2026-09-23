// Pipeline otonom PRD→MVP→fitur→rilis + project blank/PRD + followup.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.js";
import { defaultState } from "../src/state.js";
import { pushTask, cancelTask } from "../src/workflow.js";
import { pushFollowup } from "../src/workflow.js";
import { addBlank, addPrd } from "../src/projects.js";
import {
  fiturRound, nextPhase, buildPhasePrompt, startPipelineAuto,
  advancePipeline, pipelineOnFail, pipelineOnCancel,
  pausePipeline, resumePipeline, cancelPipeline,
} from "../src/pipeline.js";

let tmp = "";
let prevWs = "";

beforeEach(() => {
  prevWs = config.workspaceDir;
  tmp = mkdtempSync(join(tmpdir(), "althea-pipe-"));
  config.workspaceDir = tmp;
});
afterEach(() => {
  config.workspaceDir = prevWs;
  rmSync(tmp, { recursive: true, force: true });
});

describe("transisi fase", () => {
  it("fiturRound mem-parsing ronde", () => {
    assert.equal(fiturRound("fitur-1"), 1);
    assert.equal(fiturRound("fitur-12"), 12);
    assert.equal(fiturRound("mvp"), 0);
    assert.equal(fiturRound("fitur-x"), 0);
  });
  it("nextPhase: prd→mvp→fitur-1, rilis→tamat", () => {
    assert.equal(nextPhase("prd", "", 3), "mvp");
    assert.equal(nextPhase("mvp", "", 3), "fitur-1");
    assert.equal(nextPhase("rilis", "", 3), null);
    assert.equal(nextPhase("aneh", "", 3), "rilis");
  });
  it("fase fitur: LANJUT + ronde tersisa → ronde berikut; SELESAI/maks → rilis", () => {
    assert.equal(nextPhase("fitur-1", "ok\nLANJUT: sisa A, B", 3), "fitur-2");
    assert.equal(nextPhase("fitur-2", "SELESAI: semua jadi", 3), "rilis");
    assert.equal(nextPhase("fitur-1", "tanpa marker", 3), "rilis");
    assert.equal(nextPhase("fitur-3", "LANJUT: masih ada", 3), "rilis");
  });
  it("prompt fase memuat instruksi kuncinya", () => {
    const prd = buildPhasePrompt("prd", "pos kasir");
    assert.match(prd.prompt, /PRD\.md/);
    assert.match(prd.title, /PRD/);
    const mvp = buildPhasePrompt("mvp", "pos kasir");
    assert.match(mvp.prompt, /MVP/);
    const f = buildPhasePrompt("fitur-2", "pos kasir");
    assert.match(f.prompt, /SELESAI/);
    assert.match(f.prompt, /LANJUT/);
    assert.match(f.title, /ronde 2/);
    const r = buildPhasePrompt("rilis", "pos kasir");
    assert.match(r.prompt, /siap jual\/deploy/);
  });
});

describe("start pipeline", () => {
  it("tanpa PRD.md → mulai dari prd", async () => {
    const s = defaultState();
    const r = await addBlank(s, "kasir", "pos kasir");
    assert.equal(r.ok, true);
    const t = startPipelineAuto(s, "kasir", "pos kasir");
    assert.equal(t?.phase, "prd");
    assert.equal(t?.project, "kasir");
    assert.equal(s.projects[0].pipeline?.status, "running");
  });
  it("PRD.md sudah ada → langsung mvp", async () => {
    const s = defaultState();
    const r = await addPrd(s, "kasir", "rancangan.md", Buffer.from("# PRD\nisi"));
    assert.equal(r.ok, true);
    assert.equal(readFileSync(join(tmp, "kasir", "PRD.md"), "utf8"), "# PRD\nisi");
    const t = startPipelineAuto(s, "kasir", "wujudkan PRD");
    assert.equal(t?.phase, "mvp");
  });
});

describe("advance rantai penuh", () => {
  it("prd→mvp→fitur-1→fitur-2→rilis→done", () => {
    const s = defaultState();
    s.projects.push({ name: "k", source: "blank", stack: "generic", addedAt: "" });
    const t0 = startPipelineAuto(s, "k", "goal");
    assert.equal(t0?.phase, "prd");
    const step = (taskId: string, phase: string, out: string) => {
      const t = s.stack.find((x) => x.id === taskId);
      assert.ok(t && t.phase === phase);
      t.status = "done";
      return advancePipeline(s, t, out);
    };
    let a = step(t0!.id, "prd", "ringkasan");
    assert.equal(a?.to, "mvp");
    a = step(a!.pushed!.id, "mvp", "jalan");
    assert.equal(a?.to, "fitur-1");
    a = step(a!.pushed!.id, "fitur-1", "x\nLANJUT: sisa lapor");
    assert.equal(a?.to, "fitur-2");
    a = step(a!.pushed!.id, "fitur-2", "SELESAI: semua jadi");
    assert.equal(a?.to, "rilis");
    a = step(a!.pushed!.id, "rilis", "checklist ✓");
    assert.equal(a?.finished, true);
    assert.equal(s.projects[0].pipeline?.status, "done");
  });
  it("tugas non-fase / pipeline jeda → advance null", () => {
    const s = defaultState();
    s.projects.push({ name: "k", source: "blank", stack: "generic", addedAt: "" });
    const biasa = pushTask(s, "manual", "kerjakan", "", "k");
    assert.equal(advancePipeline(s, biasa, ""), null);
    const t0 = startPipelineAuto(s, "k", "goal");
    assert.ok(t0 && pausePipeline(s, "k"));
    assert.equal(advancePipeline(s, t0, ""), null);
  });
});

describe("kontrol pipeline", () => {
  it("gagal di fase → failed; batal tugas → jeda; resume → dorong lagi", () => {
    const s = defaultState();
    s.projects.push({ name: "k", source: "blank", stack: "generic", addedAt: "" });
    const t0 = startPipelineAuto(s, "k", "goal");
    assert.ok(t0);
    cancelTask(s, t0.id, "uji");
    assert.equal(pipelineOnCancel(s, t0.id), true);
    assert.equal(s.projects[0].pipeline?.status, "paused");
    const t1 = resumePipeline(s, "k");
    assert.equal(s.projects[0].pipeline?.status, "running");
    assert.equal(t1?.phase, "prd"); // fase tertunda diulang
    cancelTask(s, t1!.id, "uji gagal"); // tugasnya gagal dulu (seperti alur nyata)
    assert.equal(pipelineOnFail(s, t1!.id)?.phase, "prd");
    assert.equal(s.projects[0].pipeline?.status, "failed");
    const t2 = resumePipeline(s, "k"); // gagal pun bisa diulang dari fase tertunda
    assert.equal(s.projects[0].pipeline?.status, "running");
    assert.equal(t2?.phase, "prd");
  });
  it("cancelPipeline menghentikan + membatalkan tugas fase aktif", () => {
    const s = defaultState();
    s.projects.push({ name: "k", source: "blank", stack: "generic", addedAt: "" });
    const t0 = startPipelineAuto(s, "k", "goal");
    assert.equal(cancelPipeline(s, "k"), true);
    assert.equal(s.projects[0].pipeline?.status, "failed");
    assert.equal(s.stack.find((x) => x.id === t0!.id)?.status, "failed");
    assert.equal(cancelPipeline(s, "takada"), false);
  });
});

describe("project blank & PRD", () => {
  it("addBlank: folder + README + registry; tolak duplikat & nama jelek", async () => {
    const s = defaultState();
    const r = await addBlank(s, "baru", "ide keren");
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(tmp, "baru", "README.md")));
    assert.match(readFileSync(join(tmp, "baru", "README.md"), "utf8"), /ide keren/);
    assert.equal((await addBlank(s, "baru")).ok, false);
    assert.equal((await addBlank(s, "../x")).ok, false);
  });
  it("addPrd: tolak biner, kosong, dan duplikat", async () => {
    const s = defaultState();
    assert.equal((await addPrd(s, "p", "a.md", Buffer.from([0x41, 0x00]))).ok, false);
    assert.equal((await addPrd(s, "p", "a.md", Buffer.from("   "))).ok, false);
    assert.equal((await addPrd(s, "p", "a.md", Buffer.from("# ok"))).ok, true);
    assert.equal((await addPrd(s, "p", "b.md", Buffer.from("# dua"))).ok, false);
  });
});

describe("tindak lanjut", () => {
  it("pushFollowup mewarisi project + menaut induk", () => {
    const s = defaultState();
    const induk = pushTask(s, "MVP kasir", "buat", "", "kasir");
    const f = pushFollowup(s, induk.id, "tambah diskon");
    assert.equal(f?.project, "kasir");
    assert.match(f?.title || "", /lanjutan/);
    assert.match(f?.note || "", new RegExp(induk.id));
    assert.equal(pushFollowup(s, "takada", "x"), null);
    assert.equal(pushFollowup(s, induk.id, "  "), null);
  });
});
