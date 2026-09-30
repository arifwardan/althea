// Pembungkus Muse CLI: eksekusi prompt, DETEKSI LIMIT TOKEN,
// dan jadwalkan RESUME OTOMATIS tiap reset ±5 jam tanpa prompt ulang.
import { spawn } from "node:child_process";
import { config, resetMs } from "./config.js";
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";
import { createExecStream, type StreamActivity } from "./execstream.js";
import { startFileWatch } from "./projects.js";

export interface ClaudeResult {
  ok: boolean;
  output: string;
  hitLimit: boolean;
  retryAfterMs: number | null; // waktu tunggu eksplisit dari pesan limit, jika ada
  cancelled: boolean; // true bila dihentikan via kill-switch (state sudah diurus pemanggil)
  timedOut: boolean; // true bila dibunuh timer internal (bukan kill-switch)
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

// ——— Batas eksekusi: timeout per-spawn yang bisa diubah dari dashboard ———
// Preseden sama seperti otak: override dashboard (state, via PUT /api/limits)
// > env (CLAUDE_TIMEOUT_SECONDS) > default 1800 detik.
// Berlaku untuk spawn BERIKUTNYA; proses yang sedang jalan tidak diganggu.
export const TIMEOUT_MIN_SECONDS = 60;
export const TIMEOUT_MAX_SECONDS = 86400;
export const TIMEOUT_DEFAULT_SECONDS = 1800;

/** Detik valid (60–86400) atau 0 = kembali ke default. Selain itu → null (invalid). */
export function parseTimeoutSeconds(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) return null;
  if (n === 0) return 0;
  if (!Number.isInteger(n) || n < TIMEOUT_MIN_SECONDS || n > TIMEOUT_MAX_SECONDS) return null;
  return n;
}

let timeoutOverride = 0;

/** Nilai invalid → jatuh ke 0 (= default), tak pernah meledak. */
export function setTimeoutOverride(v: unknown): void {
  const n = parseTimeoutSeconds(v);
  timeoutOverride = n === null ? 0 : n;
}

export interface EffectiveTimeout {
  seconds: number;
  source: "dashboard" | "env" | "default";
}

/** Param opsional agar murni & mudah di-test; produksi selalu default. */
export function effectiveTimeoutSeconds(
  overrideSecs: number = timeoutOverride,
  envSecs: number = config.claudeTimeoutSeconds,
): EffectiveTimeout {
  if (overrideSecs > 0) return { seconds: overrideSecs, source: "dashboard" };
  if (envSecs > 0) return { seconds: envSecs, source: "env" };
  return { seconds: TIMEOUT_DEFAULT_SECONDS, source: "default" };
}

/** Susun argv spawn. Flags model/effort hanya untuk gaya exec (terverifikasi); gaya lama tetap -p. */
export function brainArgs(prompt: string, b: EffectiveBrain = effectiveBrain()): string[] {
  if (!b.subcommand) return ["-p", prompt];
  const args = [b.subcommand];
  if (b.model) args.push("--model", b.model);
  if (b.effort) args.push("--reasoning-effort", b.effort);
  // Workspace Althea milik sendiri → selalu trusted (tanpa ini delegasi subagen
  // mati: "Agent delegation unavailable: workspace is untrusted").
  args.push("--trust-workspace");
  // Headless: jangan gantung menunggu input interaktif (izin lewat baris IZIN:).
  args.push("--user-input-auto-resolve");
  // Headless tak bisa menjawab approval → tanpa ini run macet di human_pending
  // sampai timeout. Sandbox filesystem/network tetap aktif.
  args.push("--disable-approval");
  // Stream event JSONL: nama tool + jawaban streaming (diterjemah ExecStream).
  args.push("--json");
  args.push(prompt);
  return args;
}

/** Pesan spawn gagal yang actionable. ENOENT = perintah otak salah/tak ada. */
export function spawnErrorNote(bin: string, err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return `brain not found: "${bin}" (ENOENT) — check BRAIN_BIN in .env then restart the server`;
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
  prompt: string, cwd?: string, onLine?: (line: string) => void,
  onActivity?: (a: StreamActivity) => void,
): Promise<ClaudeResult> {
  if (config.claudeDryRun) {
    const line = `[DRY-RUN ${brainSummary()}${cwd ? ` @${cwd}` : ""}] ${prompt.slice(0, 500)}`;
    if (onLine) onLine(line);
    return Promise.resolve({ ok: true, output: line, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false });
  }
  return new Promise((resolve) => {
    const brain = effectiveBrain();
    const timeoutSecs = effectiveTimeoutSeconds().seconds;
    const child = spawn(brain.bin, brainArgs(prompt, brain), {
      shell: false,
      ...(cwd ? { cwd } : {}),
    });
    const ref = { child, killed: false };
    active = ref;
    // Timer manual (bukan opsi spawn): agar timeout terdeteksi pasti dan
    // dibedakan dari kill-switch — pemanggil bisa antre-ulang otomatis.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* sudah mati */ }
      setTimeout(() => {
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* abaikan */ }
      }, 10_000);
    }, timeoutSecs * 1000);
    // Pantau file project selama run (jalan tanpa project → tanpa watcher).
    const watch = cwd && onActivity ? startFileWatch(cwd, (kind, text) => onActivity({ kind, text })) : null;
    const finish = (r: ClaudeResult) => {
      clearTimeout(timer);
      watch?.stop();
      if (active === ref) active = null;
      resolve(r);
    };
    // Stream JSONL diterjemah: baris ramah → onLine, tool → onActivity,
    // potongan jawaban → transkrip (pengganti output mentah).
    const stream = createExecStream();
    let rest = "";
    let textRest = "";
    const emitText = (t: string) => {
      const buf = textRest + t;
      const parts = buf.split("\n");
      textRest = parts.pop() || "";
      for (const ln of parts) {
        if (onLine) onLine(ln.slice(0, 2000));
      }
    };
    const feed = (d: unknown) => {
      const chunk = rest + String(d);
      const parts = chunk.split("\n");
      rest = parts.pop() || "";
      for (const line of parts) {
        const r = stream.push(line);
        for (const l of r.log) {
          if (onLine) onLine(l.slice(0, 2000));
        }
        for (const a of r.activities) {
          if (onActivity) onActivity(a);
        }
        if (r.text) emitText(r.text);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => {
      finish({ ok: false, output: spawnErrorNote(brain.bin, e), hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false });
    });
    child.on("close", (code) => {
      if (rest) {
        const r = stream.push(rest);
        for (const l of r.log) {
          if (onLine) onLine(l.slice(0, 2000));
        }
        if (r.text) emitText(r.text);
      }
      if (textRest && onLine) onLine(textRest.slice(0, 2000));
      if (ref.killed) {
        finish({ ok: false, output: "CANCELLED by admin (kill-switch)", hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: false });
        return;
      }
      const transcript = stream.transcript().slice(0, 8000);
      if (timedOut) {
        finish({ ok: false, output: `TIMEOUT ${timeoutSecs}s — process killed. Partial output:\n${transcript}`, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: true });
        return;
      }
      const hitLimit = detectLimit(transcript);
      finish({
        ok: code === 0 && !hitLimit,
        output: transcript || `(exit ${code})`,
        hitLimit,
        retryAfterMs: hitLimit ? parseRetryAfter(transcript) : null,
        cancelled: false,
        timedOut: false,
      });
    });
  });
}

/** Masuk mode cooldown limit: notif + catat kapan resume otomatis. */
export function enterLimitCooldown(s: AltheaState, retryAfterMs: number | null): string {
  const wait = retryAfterMs ?? resetMs(); // default: reset langganan ±5 jam
  const until = new Date(Date.now() + wait).toISOString();
  s.limitCooldownUntil = until;
  logEvent(s, `token limit → cooldown until ${until}`);
  return until;
}

/** true = masih cooldown; false = sudah tiba waktunya resume (sekaligus reset flag). */
export function limitDue(s: AltheaState, now = new Date()): boolean {
  if (!s.limitCooldownUntil) return true;
  if (new Date(s.limitCooldownUntil).getTime() <= now.getTime()) {
    s.limitCooldownUntil = null;
    s.lastReset = now.toISOString();
    logEvent(s, "reset reached → auto-resume without re-prompting");
    return true;
  }
  return false;
}
