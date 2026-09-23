// Port default Althea: 9999 agar tak bentrok dengan aplikasi yang di-generate.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const loader = pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href;
const configTs = path.join(repo, "src", "config.ts");

// Baca config.port dari direktori kosong (tanpa .env) agar default teruji jujur.
function readPort(extraEnv = {}) {
  const { PORT: _buang, ...bersih } = process.env;
  const out = execFileSync(
    process.execPath,
    ["--import", loader, "--eval", `import(${JSON.stringify(configTs)}).then((m) => console.log(m.config.port))`],
    {
      cwd: mkdtempSync(path.join(tmpdir(), "althea-port-")),
      env: { ...bersih, ...extraEnv },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return Number(out.trim());
}

describe("port althea", () => {
  it("default 9999 saat PORT tak diset", () => {
    assert.equal(readPort(), 9999);
  });
  it("menghormati PORT dari env", () => {
    assert.equal(readPort({ PORT: "3100" }), 3100);
  });
});
