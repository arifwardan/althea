// Pembungkus Muse CLI: eksekusi prompt, DETEKSI LIMIT TOKEN,
// dan jadwalkan RESUME OTOMATIS tiap reset ±5 jam tanpa prompt ulang.
import { spawn } from "node:child_process";
import { config, resetMs } from "./config.js";
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";

export interface ClaudeResult {
  ok: boolean;
  output: string;
  hitLimit: boolean;
  retryAfterMs: number | null; // waktu tunggu eksplisit dari pesan limit, jika ada
  cancelled: boolean; // true bila dihentikan via kill-switch (state sudah diurus pemanggil)
}

// Proses Muse yang sedang jalan (maks 1; loop engine serial).
let active: { child: import("node:child_process").ChildProcess; killed: boolean } | null = null;

/**
 * Hentikan eksekusi Muse yang sedang berjalan (kill-switch).
 * SIGTERM dulu, paksa SIGKILL setelah 5 detik bila masih hidup.
 */
export function killRunning(): boolean {
  if (!active || active.killed) return false;
  active.killed = true;
  try { active.child.kill("SIGTERM"); } catch { /* sudah mati */ }
  const ref = active;
  setTimeout(() => {
    try { if (!ref.child.killed) ref.child.kill("SIGKILL"); } catch { /* abaikan */ }
    if (active === ref) active = null;
  }, 5000);
  return true;
}

// ——— Kontrol otak: model + reasoning effort untuk `muse exec` ———
// Preseden: override dashboard (state, via PUT /api/brain) > env > default CLI.
// Berlaku untuk spawn BERIKUTNYA; proses yang sedang jalan tidak diganggu.
export const BRAIN_EFFORTS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
] as const;

/** Tier valid (case-insensitive) atau "" = default CLI. Nilai asing → "". */
export function normalizeEffort(v: unknown): string {
  const t = String(v ?? "").trim().toLowerCase();
  return (BRAIN_EFFORTS as readonly string[]).includes(t) ? t : "";
}

/** Model bebas (teks), di-trim, maks 120 char. "" = default CLI. */
export function normalizeModel(v: unknown): string {
  return String(v ?? "").trim().slice(0, 120);
}

export interface BrainOverride { model: string; effort: string; }
export type BrainSource = "dashboard" | "env" | "cli-default";

export interface EffectiveBrain {
  bin: string;
  subcommand: string; // "exec" | "" (gaya lama -p)
  model: string;
  effort: string;
  modelSource: BrainSource;
  effortSource: BrainSource;
}

export interface BrainEnv { bin: string; subcommand: string; model: string; effort: string; }

// Override modul: diset dari state saat boot + tiap PUT /api/brain.
let override: BrainOverride = { model: "", effort: "" };

export function setBrainOverride(o: { model?: unknown; effort?: unknown }): void {
  override = { model: normalizeModel(o.model), effort: normalizeEffort(o.effort) };
}

const defaultEnv = (): BrainEnv => ({
  bin: config.brainBin,
  subcommand: config.brainSubcommand,
  model: normalizeModel(config.brainModel),
  effort: normalizeEffort(config.brainEffort),
});

/** Param opsional agar murni & mudah di-test; produksi selalu default. */
export function effectiveBrain(o: BrainOverride = override, env: BrainEnv = defaultEnv()): EffectiveBrain {
  const model = o.model || env.model;
  const effort = o.effort || env.effort;
  return {
    bin: env.bin,
    subcommand: env.subcommand,
    model,
    effort,
    modelSource: o.model ? "dashboard" : env.model ? "env" : "cli-default",
    effortSource: o.effort ? "dashboard" : env.effort ? "env" : "cli-default",
  };
}

/** Susun argv spawn. Flags model/effort hanya untuk gaya exec (terverifikasi); gaya lama tetap -p. */
export function brainArgs(prompt: string, b: EffectiveBrain = effectiveBrain()): string[] {
  if (!b.subcommand) return ["-p", prompt];
  const args = [b.subcommand];
  if (b.model) args.push("--model", b.model);
  if (b.effort) args.push("--reasoning-effort", b.effort);
  args.push(prompt);
  return args;
}

/** Pesan spawn gagal yang actionable. ENOENT = perintah otak salah/tak ada. */
export function spawnErrorNote(bin: string, err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return `otak tidak ditemukan: "${bin}" (ENOENT) — cek BRAIN_BIN di .env lalu restart server`;
  }
  return `spawn error: ${String(err)}`;
}

/** Ringkasan satu baris untuk log boot. */
export function brainSummary(b: EffectiveBrain = effectiveBrain()): string {
  const cmd = b.subcommand ? `${b.bin} ${b.subcommand}` : `${b.bin} -p`;
  return `${cmd} · model ${b.model || "default"} · effort ${b.effort || "default"}`;
}

// Pola pesan limit/kuota dari CLI/API (dicocokkan case-insensitive).
const LIMIT_PATTERNS = [
  /usage\s*limit/i,
  /rate\s*limit/i,
  /token\s*limit/i,
  /quota/i,
  /overloaded/i,
  /too many requests/i,
  /429/,
  /try again in/i,
  /reset(s|ting)?\s*(at|in)/i,
  /limit reached/i,
  /exceed/i,
];

export function detectLimit(text: string): boolean {
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Coba baca "try again in N ..." → ms. Dukung detik/menit/jam. */
export function parseRetryAfter(text: string): number | null {
  const m = text.match(/try again in\s+(\d+)\s*(second|minute|hour|detik|menit|jam)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult =
    unit.startsWith("hour") || unit.startsWith("jam") ? 3_600_000
    : unit.startsWith("min") || unit.startsWith("menit") ? 60_000
    : 1_000;
  return n * mult;
}

export function runClaude(
  prompt: string, cwd?: string, onLine?: (line: string) => void
): Promise<ClaudeResult> {
  if (config.claudeDryRun) {
    const line = `[DRY-RUN ${brainSummary()}${cwd ? ` @${cwd}` : ""}] ${prompt.slice(0, 500)}`;
    if (onLine) onLine(line);
    return Promise.resolve({ ok: true, output: line, hitLimit: false, retryAfterMs: null, cancelled: false });
  }
  return new Promise((resolve) => {
    const brain = effectiveBrain();
    const child = spawn(brain.bin, brainArgs(prompt, brain), {
      timeout: config.claudeTimeoutSeconds * 1000,
      shell: false,
      ...(cwd ? { cwd } : {}),
    });
    const ref = { child, killed: false };
    active = ref;
    const finish = (r: ClaudeResult) => {
      if (active === ref) active = null;
      resolve(r);
    };
    let out = "";
    let err = "";
    let rest = "";
    const feed = (d: unknown) => {
      const chunk = rest + String(d);
      const parts = chunk.split("\n");
      rest = parts.pop() || "";
      for (const line of parts) {
        if (onLine) onLine(line.slice(0, 2000));
      }
    };
    child.stdout.on("data", (d) => { out += String(d); feed(d); });
    child.stderr.on("data", (d) => { err += String(d); feed(d); });
    child.on("error", (e) => {
      finish({ ok: false, output: spawnErrorNote(brain.bin, e), hitLimit: false, retryAfterMs: null, cancelled: false });
    });
    child.on("close", (code) => {
      if (rest && onLine) onLine(rest.slice(0, 2000));
      if (ref.killed) {
        finish({ ok: false, output: "DIBATALKAN oleh admin (kill-switch)", hitLimit: false, retryAfterMs: null, cancelled: true });
        return;
      }
      const combined = `${out}\n${err}`.slice(0, 8000);
      const hitLimit = detectLimit(combined);
      finish({
        ok: code === 0 && !hitLimit,
        output: combined || `(exit ${code})`,
        hitLimit,
        retryAfterMs: hitLimit ? parseRetryAfter(combined) : null,
        cancelled: false,
      });
    });
  });
}

/** Masuk mode cooldown limit: notif + catat kapan resume otomatis. */
export function enterLimitCooldown(s: AltheaState, retryAfterMs: number | null): string {
  const wait = retryAfterMs ?? resetMs(); // default: reset langganan ±5 jam
  const until = new Date(Date.now() + wait).toISOString();
  s.limitCooldownUntil = until;
  logEvent(s, `limit token → cooldown sampai ${until}`);
  return until;
}

/** true = masih cooldown; false = sudah tiba waktunya resume (sekaligus reset flag). */
export function limitDue(s: AltheaState, now = new Date()): boolean {
  if (!s.limitCooldownUntil) return true;
  if (new Date(s.limitCooldownUntil).getTime() <= now.getTime()) {
    s.limitCooldownUntil = null;
    s.lastReset = now.toISOString();
    logEvent(s, "reset tiba → resume otomatis tanpa prompt ulang");
    return true;
  }
  return false;
}
