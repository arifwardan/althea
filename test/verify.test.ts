// Verifier deterministik: deteksi skrip, lewati yang tak ada, berhenti di gagal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pkgScripts, runVerifyGates, realRunCmd } from "../src/verify.js";

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
      const v = await runVerifyGates(d, ["check", "build"], 5000, async (s) => {
        seen.push(s);
        return s === "check" ? { code: 0, output: "ok" } : { code: 1, output: "A".repeat(5000) };
      });
      assert.equal(v.ok, false);
      assert.deepEqual(seen, ["check", "build"]);
      assert.match(v.summary, /npm run build/);
      assert.ok(v.summary.length <= 2000);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("runVerifyGates (npm asli)", () => {
  it("skrip node trivial lolos", async (t) => {
    let npmOk = true;
    try {
      execFileSync("npm", ["--version"], { stdio: "ignore" });
    } catch {
      npmOk = false;
    }
    if (!npmOk) t.skip("npm tak tersedia");
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
