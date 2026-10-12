// Verifier deterministik: deteksi skrip, lewati yang tak ada, berhenti di gagal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pkgScripts, runVerifyGates, realRunCmd } from "../src/verify.js";
import { config, normalizeJsRunner } from "../src/config.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "althea-verify-"));
}

describe("pkgScripts", () => {
  it("tanpa package.json → null; rusak → []", () => {
    const d = tmpDir();
    try {
      assert.equal(pkgScripts(d), null);
      writeFileSync(join(d, "package.json"), "{rusak");
      assert.deepEqual(pkgScripts(d), []);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("membaca daftar skrip", () => {
    const d = tmpDir();
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { check: "x", build: "y" } }));
      assert.deepEqual(pkgScripts(d), ["check", "build"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("runVerifyGates (runner palsu)", () => {
  it("melewati skrip yang tak ada, lolos bila cocok tak ada", async () => {
    const d = tmpDir();
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: {} }));
      const v = await runVerifyGates(d, ["check", "build"], 5000, async () => {
        throw new Error("tak boleh dipanggil");
      });
      assert.equal(v.ok, true);
      assert.equal(v.ran, 0);
      assert.match(v.summary, /skipped/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("berhenti di kegagalan pertama + ringkasan jadi feedback", async () => {
    const d = tmpDir();
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { check: "a", build: "b" } }));
      const seen: string[] = [];
      // Runner eksplisit agar tak ikut .env lokal (JS_RUNNER).
      const v = await runVerifyGates(d, ["check", "build"], 5000, async (s) => {
        seen.push(s);
        return s === "check" ? { code: 0, output: "ok" } : { code: 1, output: "A".repeat(5000) };
      }, "npm");
      assert.equal(v.ok, false);
      assert.deepEqual(seen, ["check", "build"]);
      assert.match(v.summary, /npm run build/);
      assert.ok(v.summary.length <= 2000);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("JS_RUNNER npm|bun", () => {
  it("normalizeJsRunner: hanya 'bun' yang lolos, selain itu npm", () => {
    assert.equal(normalizeJsRunner("bun"), "bun");
    assert.equal(normalizeJsRunner(" Bun "), "bun");
    assert.equal(normalizeJsRunner("npm"), "npm");
    assert.equal(normalizeJsRunner(""), "npm");
    assert.equal(normalizeJsRunner("pnpm"), "npm");
    assert.equal(normalizeJsRunner(null), "npm");
  });
  it("ringkasan gagal menyebut runner yang dipakai", async () => {
    const d = tmpDir();
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "b" } }));
      const fail = async () => ({ code: 1, output: "boom" });
      const vBun = await runVerifyGates(d, ["build"], 5000, fail, "bun");
      assert.match(vBun.summary, /bun run build/);
      const vNpm = await runVerifyGates(d, ["build"], 5000, fail, "pnpm");
      assert.match(vNpm.summary, /npm run build/); // asing = fallback npm
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("runVerifyGates (runner asli)", () => {
  it("skrip node trivial lolos", async (t) => {
    // Mengikuti runner terkonfigurasi (JS_RUNNER npm|bun), bukan npm mentah.
    const runner = normalizeJsRunner(config.jsRunner);
    let runnerOk = true;
    try {
      execFileSync(runner, ["--version"], { stdio: "ignore" });
    } catch {
      runnerOk = false;
    }
    if (!runnerOk) t.skip("JS runner tak tersedia");
    const d = tmpDir();
    try {
      writeFileSync(join(d, "package.json"), JSON.stringify({
        scripts: { check: 'node -e "process.exit(0)"' },
      }));
      const v = await runVerifyGates(d, ["check"], 30_000, realRunCmd);
      assert.equal(v.ok, true);
      assert.equal(v.ran, 1);
      assert.match(v.summary, /verifier passed/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
