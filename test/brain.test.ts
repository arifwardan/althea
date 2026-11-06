// Kontrol otak via dashboard: model + effort untuk `muse exec`.
// Berlaku untuk spawn berikutnya (override dashboard > default env > default CLI).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BRAIN_EFFORTS, normalizeEffort, normalizeModel, normalizeAgent, normalizeBin,
  effectiveBrain, brainArgs, setBrainOverride, spawnErrorNote,
  MUSE_MODELS, parseOpenCodeProviders, parseOpenCodeModels,
  listBrainModels, clearBrainCatalogCache,
} from "../src/claude.js";
import { loadState } from "../src/state.js";
import { detectBrainAgent } from "../src/config.js";

const ENV = { bin: "muse", agent: "muse", subcommand: "exec", model: "", effort: "" };
const OC = { bin: "opencode", agent: "opencode", subcommand: "run", model: "", effort: "" };

describe("validasi model/effort", () => {
  it("effort hanya menerima 8 tier (case-insensitive), selain itu default", () => {
    assert.deepEqual([...BRAIN_EFFORTS],
      ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    assert.equal(normalizeEffort("high"), "high");
    assert.equal(normalizeEffort("XHigh"), "xhigh");
    assert.equal(normalizeEffort(""), "");
    assert.equal(normalizeEffort("turbo"), "");
    assert.equal(normalizeEffort(42), "");
  });
  it("model di-trim dan dibatasi 120 karakter", () => {
    assert.equal(normalizeModel("  m1  "), "m1");
    assert.equal(normalizeModel("x".repeat(200)).length, 120);
    assert.equal(normalizeModel(null), "");
  });
  it("agent hanya muse/opencode (case-insensitive), selain itu default", () => {
    assert.equal(normalizeAgent("opencode"), "opencode");
    assert.equal(normalizeAgent(" Muse "), "muse");
    assert.equal(normalizeAgent(""), "");
    assert.equal(normalizeAgent("claude"), "");
    assert.equal(normalizeAgent(42), "");
  });
  it("bin di-trim dan dibatasi 200 karakter", () => {
    assert.equal(normalizeBin("  opencode  "), "opencode");
    assert.equal(normalizeBin("x".repeat(300)).length, 200);
    assert.equal(normalizeBin(null), "");
  });
});

describe("preseden: dashboard > env > default CLI", () => {
  it("override dashboard menang atas env", () => {
    const b = effectiveBrain(
      { model: "m-dash", effort: "low" },
      { ...ENV, model: "m-env", effort: "high" },
    );
    assert.equal(b.model, "m-dash");
    assert.equal(b.effort, "low");
    assert.equal(b.modelSource, "dashboard");
    assert.equal(b.effortSource, "dashboard");
  });
  it("override kosong → jatuh ke env → default CLI", () => {
    const b = effectiveBrain({ model: "", effort: "" }, { ...ENV, model: "", effort: "" });
    assert.equal(b.model, "");
    assert.equal(b.effort, "");
    assert.equal(b.modelSource, "cli-default");
    assert.equal(b.effortSource, "cli-default");
    const c = effectiveBrain({ model: "", effort: "" }, { ...ENV, model: "m-env", effort: "" });
    assert.equal(c.model, "m-env");
    assert.equal(c.modelSource, "env");
  });
  it("setBrainOverride mengubah spawn berikutnya (modul)", () => {
    try {
      setBrainOverride({ model: "m-baru", effort: "ultra" });
      const b = effectiveBrain(undefined, ENV);
      assert.equal(b.model, "m-baru");
      assert.equal(b.effort, "ultra");
    } finally {
      setBrainOverride({ model: "", effort: "" });
    }
  });
  it("override agen dashboard menang atas env + subcommand mengikuti", () => {
    const b = effectiveBrain({ model: "", effort: "", agent: "opencode", bin: "opencode" }, ENV);
    assert.equal(b.agent, "opencode");
    assert.equal(b.bin, "opencode");
    assert.equal(b.subcommand, "run");
    assert.equal(b.agentSource, "dashboard");
    assert.equal(b.binSource, "dashboard");
    const c = effectiveBrain({ model: "", effort: "", agent: "muse", bin: "" }, OC);
    assert.equal(c.agent, "muse");
    assert.equal(c.bin, "opencode"); // bin kosong = tetap env
    assert.equal(c.subcommand, "exec");
  });
  it("bin kustom tanpa agen → ditebak dari nama biner", () => {
    const b = effectiveBrain({ model: "", effort: "", bin: "/opt/OpenCode" }, ENV);
    assert.equal(b.agent, "opencode");
    assert.equal(b.bin, "/opt/OpenCode");
    assert.equal(b.subcommand, "run");
    const c = effectiveBrain({ model: "", effort: "", bin: "/usr/bin/muse" }, OC);
    assert.equal(c.agent, "muse");
    assert.equal(c.subcommand, "exec");
  });
  it("tanpa override → ikut env termasuk gaya lama -p", () => {
    const b = effectiveBrain({ model: "", effort: "" }, { ...ENV, subcommand: "" });
    assert.equal(b.agent, "muse");
    assert.equal(b.bin, "muse");
    assert.equal(b.subcommand, "");
    assert.equal(b.agentSource, "env");
  });
  it("setBrainOverride agen mengubah spawn berikutnya (modul)", () => {
    try {
      setBrainOverride({ agent: "opencode", bin: "opencode" });
      const b = effectiveBrain(undefined, ENV);
      assert.equal(b.agent, "opencode");
      assert.equal(b.subcommand, "run");
      assert.deepEqual(brainArgs("KERJAKAN", b),
        ["run", "--format", "json", "--auto", "--standalone", "KERJAKAN"]);
    } finally {
      setBrainOverride({ model: "", effort: "" });
    }
  });
});

describe("argumen spawn", () => {
  it("gaya exec: flags model/effort + trust + headless + json sebelum prompt", () => {
    const b = effectiveBrain({ model: "m1", effort: "high" }, ENV);
    assert.deepEqual(brainArgs("KERJAKAN", b),
      ["exec", "--model", "m1", "--reasoning-effort", "high", "--trust-workspace", "--user-input-auto-resolve", "--disable-approval", "--json", "KERJAKAN"]);
  });
  it("gaya exec: default yang kosong dihilangkan, trust selalu ada", () => {
    const b = effectiveBrain({ model: "", effort: "" }, ENV);
    assert.deepEqual(brainArgs("KERJAKAN", b), ["exec", "--trust-workspace", "--user-input-auto-resolve", "--disable-approval", "--json", "KERJAKAN"]);
  });
  it("gaya lama (subcommand kosong): tetap -p tanpa flags", () => {
    const b = effectiveBrain(
      { model: "m1", effort: "high" },
      { ...ENV, bin: "Muse", subcommand: "" },
    );
    assert.deepEqual(brainArgs("KERJAKAN", b), ["-p", "KERJAKAN"]);
  });
  it("opencode: run --model --format json --auto --standalone <prompt>", () => {
    const b = effectiveBrain({ model: "provider/model", effort: "high" }, OC);
    assert.equal(b.agent, "opencode");
    assert.deepEqual(brainArgs("KERJAKAN", b),
      ["run", "--model", "provider/model", "--format", "json", "--auto", "--standalone", "KERJAKAN"]);
  });
  it("opencode: model/effort kosong dihilangkan, effort tak dipakai CLI ini", () => {
    const b = effectiveBrain({ model: "", effort: "" }, OC);
    assert.deepEqual(brainArgs("KERJAKAN", b), ["run", "--format", "json", "--auto", "--standalone", "KERJAKAN"]);
  });
  it("opencode: subcommand kosong → run", () => {
    const b = effectiveBrain({ model: "", effort: "" }, { ...OC, subcommand: "" });
    assert.deepEqual(brainArgs("KERJAKAN", b), ["run", "--format", "json", "--auto", "--standalone", "KERJAKAN"]);
  });
});

describe("deteksi agen", () => {
  it("explicit BRAIN_AGENT menang", () => {
    assert.equal(detectBrainAgent("muse", "opencode"), "opencode");
    assert.equal(detectBrainAgent("opencode", "muse"), "muse");
  });
  it("ditebak dari nama biner; lainnya = muse", () => {
    assert.equal(detectBrainAgent("opencode"), "opencode");
    assert.equal(detectBrainAgent("/usr/local/bin/OpenCode"), "opencode");
    assert.equal(detectBrainAgent("muse"), "muse");
    assert.equal(detectBrainAgent("claude"), "muse");
    assert.equal(detectBrainAgent("muse", "aneh"), "muse"); // nilai asing diabaikan
  });
});

describe("pesan spawn gagal", () => {
  it("ENOENT → sebut perintah + suruh cek BRAIN_BIN", () => {
    const err = Object.assign(new Error("spawn xxx ENOENT"), { code: "ENOENT" });
    const note = spawnErrorNote("xxx", err);
    assert.match(note, /brain not found/);
    assert.match(note, /"xxx"/);
    assert.match(note, /BRAIN_BIN/);
  });
  it("error lain → pesan generik", () => {
    assert.match(spawnErrorNote("b", new Error("boom")), /spawn error/);
  });
});

describe("migrasi state lama", () => {
  it("state tanpa field brain dapat default kosong", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-brain-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({ version: 1, stack: [] }));
    const s = loadState(p);
    assert.deepEqual(s.brain, { model: "", effort: "", bin: "", agent: "", subcommand: "" });
  });
  it("agen asing dibersihkan, field teks non-string dikosongkan", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-brain-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({
      version: 1, stack: [],
      brain: { model: "m", effort: "high", bin: 42, agent: "claude", subcommand: null },
    }));
    const s = loadState(p);
    assert.deepEqual(s.brain, { model: "m", effort: "high", bin: "", agent: "", subcommand: "" });
  });
  it("agen tersimpan valid dipertahankan", () => {
    const dir = mkdtempSync(join(tmpdir(), "althea-brain-"));
    const p = join(dir, "state.json");
    writeFileSync(p, JSON.stringify({
      version: 1, stack: [],
      brain: { model: "", effort: "", bin: "opencode", agent: "opencode", subcommand: "" },
    }));
    const s = loadState(p);
    assert.equal(s.brain.agent, "opencode");
    assert.equal(s.brain.bin, "opencode");
  });
});

describe("katalog model dashboard", () => {
  it("muse: daftar terkurasi tanpa subprocess", () => {
    let calls = 0;
    const cat = listBrainModels({
      agent: "muse", bin: "muse",
      run: () => { calls++; return null; }, useCache: false,
    });
    assert.equal(calls, 0);
    assert.deepEqual(cat.providers, []);
    assert.deepEqual(cat.models.map((m) => m.value), [...MUSE_MODELS]);
    assert.ok(MUSE_MODELS.length > 0);
  });
  it("parseOpenCodeProviders: hanya yang punya koneksi", () => {
    const raw = JSON.stringify([
      { id: "kilo", name: "Kilo Gateway", connections: [{ type: "credential" }] },
      { id: "kosong", name: "Empty", connections: [] },
      { id: "rusak", name: "Broken" },
    ]);
    assert.deepEqual(parseOpenCodeProviders(raw), [{ id: "kilo", name: "Kilo Gateway" }]);
    assert.deepEqual(parseOpenCodeProviders("bukan json"), []);
    assert.deepEqual(parseOpenCodeProviders(null), []);
  });
  it("parseOpenCodeModels: saring provider, unik, terurut", () => {
    const raw = "kilo/b\nopenrouter/y\nlain/z\n\nkilo/b\nkilo/a\ntanpa-slash\n";
    assert.deepEqual(parseOpenCodeModels(raw, ["kilo"]), [
      { value: "kilo/a", label: "a", provider: "kilo" },
      { value: "kilo/b", label: "b", provider: "kilo" },
    ]);
    assert.deepEqual(parseOpenCodeModels(null, ["kilo"]), []);
  });
  it("listBrainModels opencode: gabungan + cache sekali panggil", () => {
    clearBrainCatalogCache();
    let calls = 0;
    const run = (_bin: string, args: string[], _t: number): string | null => {
      calls++;
      if (args[0] === "auth") {
        return JSON.stringify([{ id: "kilo", name: "Kilo", connections: [{}] }]);
      }
      return "kilo/b\nopenrouter/y\n";
    };
    try {
      const a = listBrainModels({ agent: "opencode", bin: "opencode", run });
      assert.deepEqual(a.providers, [{ id: "kilo", name: "Kilo" }]);
      assert.deepEqual(a.models.map((m) => m.value), ["kilo/b"]);
      const b = listBrainModels({ agent: "opencode", bin: "opencode", run });
      assert.deepEqual(b, a);
      assert.equal(calls, 2); // auth + models sekali; panggilan kedua dari cache
    } finally {
      clearBrainCatalogCache();
    }
  });
  it("CLI gagal → katalog kosong (UI fallback, tak meledak)", () => {
    clearBrainCatalogCache();
    try {
      const cat = listBrainModels({ agent: "opencode", bin: "opencode", run: () => null });
      assert.deepEqual(cat, { providers: [], models: [] });
    } finally {
      clearBrainCatalogCache();
    }
  });
});
