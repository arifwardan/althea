// Pembungkus Muse CLI: eksekusi prompt + DETEKSI LIMIT TOKEN.
// Tanpa cooldown: limit langsung menggagalkan tugas (admin ganti
// model/provider lalu jalankan ulang) — tak ada tunggu otomatis.
import { spawn, execFileSync } from "node:child_process";
import { config, detectBrainAgent } from "./config.js";
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

/** Agen coding valid atau "" = ikut env/tebakan biner. Nilai asing → "". */
export function normalizeAgent(v: unknown): string {
  const t = String(v ?? "").trim().toLowerCase();
  return t === "muse" || t === "opencode" ? t : "";
}

/** Perintah biner otak, di-trim, maks 200 char. "" = ikut env. */
export function normalizeBin(v: unknown): string {
  return String(v ?? "").trim().slice(0, 200);
}

export interface BrainOverride {
  model: string; effort: string; bin?: string; agent?: string; subcommand?: string;
}
export type BrainSource = "dashboard" | "env" | "cli-default";

export interface EffectiveBrain {
  bin: string;
  agent: string; // "muse" (Muse Code) | "opencode" (OpenCode)
  subcommand: string; // "exec" | "run" | "" (gaya lama -p)
  model: string;
  effort: string;
  binSource: BrainSource;
  agentSource: BrainSource;
  modelSource: BrainSource;
  effortSource: BrainSource;
}

export interface BrainEnv { bin: string; agent: string; subcommand: string; model: string; effort: string; }

// Override modul: diset dari state saat boot + tiap PUT /api/brain.
let override: BrainOverride = { model: "", effort: "" };

export function setBrainOverride(o: { model?: unknown; effort?: unknown; bin?: unknown; agent?: unknown; subcommand?: unknown }): void {
  override = {
    model: normalizeModel(o.model),
    effort: normalizeEffort(o.effort),
    bin: normalizeBin(o.bin),
    agent: normalizeAgent(o.agent),
    subcommand: String(o.subcommand ?? "").trim().slice(0, 120),
  };
}

const defaultEnv = (): BrainEnv => ({
  bin: config.brainBin,
  agent: config.brainAgent,
  subcommand: config.brainSubcommand,
  model: normalizeModel(config.brainModel),
  effort: normalizeEffort(config.brainEffort),
});

/** Param opsional agar murni & mudah di-test; produksi selalu default. */
export function effectiveBrain(o: BrainOverride = override, env: BrainEnv = defaultEnv()): EffectiveBrain {
  const model = o.model || env.model;
  const effort = o.effort || env.effort;
  // Pilihan agen dari dashboard (bin/agent) mengalahkan env; bin kustom tanpa
  // agen eksplisit ditebak dari namanya; subcommand mengikuti agen terpilih
  // (exec/run) kecuali env memaksa gaya lama -p dan dashboard tak campur tangan.
  const bin = o.bin || env.bin;
  const agent = o.agent || (o.bin ? detectBrainAgent(o.bin, "") : env.agent);
  const dashTouched = !!(o.bin || o.agent);
  const subcommand = o.subcommand || (dashTouched ? (agent === "opencode" ? "run" : "exec") : env.subcommand);
  return {
    bin,
    agent,
    subcommand,
    model,
    effort,
    binSource: o.bin ? "dashboard" : "env",
    agentSource: dashTouched ? "dashboard" : "env",
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

/** Susun argv spawn per agen. */
export function brainArgs(prompt: string, b: EffectiveBrain = effectiveBrain()): string[] {
  // OpenCode: `opencode run [--model provider/model] --format json --auto --standalone <prompt>`.
  // --format json → stream event JSONL (diterjemah ExecStream);
  // --auto → auto-approve izin yang tak ditolak eksplisit (setara
  // --disable-approval muse: althea punya jalur izin sendiri via web/Telegram,
  // run headless tak bisa menjawab approval interaktif);
  // --standalone → server privat per run (tidak bergantung pada — atau
  // bertabrakan dengan — layanan latar opencode milik user).
  if (b.agent === "opencode") {
    const args = [b.subcommand || "run"];
    if (b.model) args.push("--model", b.model);
    args.push("--format", "json", "--auto", "--standalone");
    args.push(prompt);
    return args;
  }
  // Muse Code (gaya exec; subcommand kosong = gaya lama -p).
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

// ——— Katalog model untuk select dashboard ———
// muse: daftar terkurasi (resolve-nya terverifikasi via `muse model-profile show`).
// opencode: provider terautentikasi (`opencode auth list --format json`) ×
// model (`opencode models`) yang berawalan provider tersebut.
export interface BrainProvider { id: string; name: string; }
export interface BrainModelOption { value: string; label: string; provider: string; }
export interface BrainCatalog { providers: BrainProvider[]; models: BrainModelOption[]; }

/** Model muse yang terbukti resolve (model-profile show exit 0). */
export const MUSE_MODELS = ["muse-spark", "muse-spark-1.3"];

export type CatalogRun = (bin: string, args: string[], timeoutMs: number) => string | null;

function defaultCatalogRun(bin: string, args: string[], timeoutMs: number): string | null {
  try {
    const out = execFileSync(bin, args, {
      encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
    });
    return typeof out === "string" ? out : String(out);
  } catch {
    return null;
  }
}

/** Provider opencode yang punya koneksi tersimpan (dari JSON `auth list`). */
export function parseOpenCodeProviders(raw: string | null): BrainProvider[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: BrainProvider[] = [];
    for (const p of v as Array<Record<string, unknown>>) {
      if (typeof p?.id === "string" && p.id && typeof p?.name === "string" &&
        Array.isArray(p?.connections) && (p.connections as unknown[]).length > 0) {
        out.push({ id: p.id as string, name: p.name as string });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Saring baris `opencode models` ke provider terdaftar ("provider/model", unik, terurut). */
export function parseOpenCodeModels(raw: string | null, providerIds: Set<string> | string[]): BrainModelOption[] {
  const set = providerIds instanceof Set ? providerIds : new Set(providerIds);
  if (!raw) return [];
  const out: BrainModelOption[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || !t.includes("/")) continue;
    const i = t.indexOf("/");
    const provider = t.slice(0, i);
    const model = t.slice(i + 1);
    if (!set.has(provider) || !model || seen.has(t)) continue;
    seen.add(t);
    out.push({ value: t, label: model, provider });
  }
  return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

export interface CatalogOpts { agent?: string; bin?: string; run?: CatalogRun; useCache?: boolean; }

const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache: { key: string; at: number; cat: BrainCatalog } | null = null;

/** Kosongkan cache katalog (untuk test). */
export function clearBrainCatalogCache(): void {
  catalogCache = null;
}

/** Katalog select dashboard sesuai agen aktif. Gagal baca CLI → katalog kosong (UI fallback). */
export function listBrainModels(opts: CatalogOpts = {}): BrainCatalog {
  const b = effectiveBrain();
  const agent = opts.agent || b.agent;
  const bin = opts.bin || b.bin;
  if (agent !== "opencode") {
    return {
      providers: [],
      models: MUSE_MODELS.map((m) => ({ value: m, label: m, provider: "muse" })),
    };
  }
  if (opts.useCache !== false && catalogCache && catalogCache.key === bin &&
    Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.cat;
  }
  const run = opts.run || defaultCatalogRun;
  const providers = parseOpenCodeProviders(run(bin, ["auth", "list", "--format", "json"], 15_000));
  const models = parseOpenCodeModels(run(bin, ["models"], 20_000), providers.map((p) => p.id));
  const cat = { providers, models };
  if (opts.useCache !== false) catalogCache = { key: bin, at: Date.now(), cat };
  return cat;
}

/** Ringkasan satu baris untuk log boot. */
export function brainSummary(b: EffectiveBrain = effectiveBrain()): string {
  const cmd = b.subcommand ? `${b.bin} ${b.subcommand}` : `${b.bin} -p`;
  return `[${b.agent}] ${cmd} · model ${b.model || "default"} · effort ${b.effort || "default"}`;
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

/**
 * true = run gagal karena LIMIT KUOTA provider.
 * Sinyal sah = error ASLI dari CLI/API (baris non-JSON stdout/stderr,
 * event error opencode, task.lifecycle.failed muse) — selalu diperiksa.
 * Jawaban AI (transkrip) hanya diperiksa bila run gagal (exit ≠ 0):
 * prosa normal yang menyebut "quota"/"limit" saat bekerja BUKAN limit.
 * Limit langsung menggagalkan tugas (tanpa cooldown); admin tinggal ganti
 * model/provider lain yang belum kena limit, lalu jalankan ulang.
 */
export function limitHit(exitCode: number | null, errorText: string, transcript: string): boolean {
  if (detectLimit(errorText)) return true;
  return exitCode !== 0 && detectLimit(transcript);
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
      // stdin ditutup (EOF langsung): opencode membaca stdin bila
      // pesannya kosong/tidak ada — dengan pipe terbuka run gantung
      // selamanya. stdout/stderr tetap pipa untuk stream JSONL.
      stdio: ["ignore", "pipe", "pipe"],
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
      const errorText = stream.errors();
      if (timedOut) {
        finish({ ok: false, output: `TIMEOUT ${timeoutSecs}s — process killed. Partial output:\n${transcript}`, hitLimit: false, retryAfterMs: null, cancelled: false, timedOut: true });
        return;
      }
      const hitLimit = limitHit(code, errorText, transcript);
      finish({
        ok: code === 0 && !hitLimit,
        output: transcript || `(exit ${code})`,
        hitLimit,
        retryAfterMs: hitLimit ? parseRetryAfter(`${errorText}\n${transcript}`) : null,
        cancelled: false,
        timedOut: false,
      });
    });
  });
}


