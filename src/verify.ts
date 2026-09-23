// Verifier deterministik (FR-3.10): skrip npm project (check/test/build)
// dijalankan sistem lokal setelah implementasi. 0 token LLM; gagal = feedback
// ronde berikutnya (tanpa memanggil model). Aman: hanya skrip yang ADA di
// package.json yang dijalankan; tanpa package.json dilewati.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface VerifyStep {
  script: string;
  ok: boolean;
  skipped?: boolean;
  output: string;
  ms: number;
}

export interface VerifyResult {
  ok: boolean;
  ran: number; // skrip yang benar-benar dieksekusi
  summary: string; // ringkas, siap jadi feedback coder (sudah dipangkas)
  steps: VerifyStep[];
}

/** Daftar skrip di package.json cwd; null bila tanpa package.json. */
export function pkgScripts(cwd: string): string[] | null {
  const f = join(cwd, "package.json");
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { scripts?: unknown };
    const s = j?.scripts;
    if (!s || typeof s !== "object") return [];
    return Object.keys(s as Record<string, unknown>);
  } catch {
    return [];
  }
}

export type RunCmd = (
  script: string, cwd: string, timeoutMs: number,
) => Promise<{ code: number; output: string }>;

export function realRunCmd(script: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("npm", ["run", script], { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code?: unknown }).code as number) : 1) : 0;
      resolve({ code, output: String(stdout || stderr || "").slice(-2000) });
    });
  });
}

/** Jalankan skrip berurutan; berhenti di kegagalan pertama. */
export async function runVerifyGates(
  cwd: string, scripts: string[], timeoutMs: number, run: RunCmd = realRunCmd,
): Promise<VerifyResult> {
  const avail = pkgScripts(cwd);
  if (!avail) return { ok: true, ran: 0, summary: "verifier dilewati (tanpa package.json)", steps: [] };
  const steps: VerifyStep[] = [];
  for (const s of scripts) {
    if (!avail.includes(s)) {
      steps.push({ script: s, ok: true, skipped: true, output: "", ms: 0 });
      continue;
    }
    const t0 = Date.now();
    const r = await run(s, cwd, timeoutMs);
    const ms = Date.now() - t0;
    const output = r.output.slice(-2000);
    steps.push({ script: s, ok: r.code === 0, output, ms });
    if (r.code !== 0) {
      return {
        ok: false,
        ran: steps.filter((x) => !x.skipped).length,
        summary: `verifier gagal di "npm run ${s}":\n${output}`.slice(0, 2000),
        steps,
      };
    }
  }
  const ran = steps.filter((x) => !x.skipped).length;
  const detail = steps.filter((x) => !x.skipped).map((x) => `${x.script} (${(x.ms / 1000).toFixed(1)}s)`).join(", ");
  return {
    ok: true,
    ran,
    summary: ran ? `verifier lolos: ${detail}` : "verifier dilewati (tak ada skrip yang cocok)",
    steps,
  };
}
