// Konfigurasi dari env. Sengaja tanpa lib dotenv: parse file .env manual agar nol dependensi.
import { readFileSync, existsSync } from "node:fs";

function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadDotEnv();

function num(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

export const config = {
  port: num("PORT", 3000),
  host: process.env.HOST || "127.0.0.1",
  statePath: process.env.STATE_PATH || "./data/state.json",
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  adminIds: (process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  telegramPollSeconds: num("TELEGRAM_POLL_SECONDS", 5),
  claudeBin: process.env.CLAUDE_BIN || "Muse",
  // Otak: `muse exec` (+ --model/--reasoning-effort). BRAIN_SUBCOMMAND="" = gaya lama `Muse -p`.
  brainBin: process.env.BRAIN_BIN || process.env.CLAUDE_BIN || "muse",
  brainSubcommand: process.env.BRAIN_SUBCOMMAND ?? "exec",
  brainModel: (process.env.BRAIN_MODEL || "").trim(),
  brainEffort: (process.env.BRAIN_EFFORT || "").trim().toLowerCase(),
  claudeResetHours: num("CLAUDE_RESET_HOURS", 5) || 5,
  claudeTimeoutSeconds: num("CLAUDE_TIMEOUT_SECONDS", 600) || 600,
  claudeDryRun: process.env.CLAUDE_DRY_RUN === "1",
  loopSeconds: num("LOOP_SECONDS", 15) || 15,
  reportEveryHours: num("REPORT_EVERY_HOURS", 6),
  // Aturan eskalasi izin: web N menit → telegram M menit → putuskan sendiri.
  approvalWebMinutes: num("APPROVAL_WEB_MINUTES", 3),
  approvalTelegramMinutes: num("APPROVAL_TELEGRAM_MINUTES", 3),
  approvalAutodecide: process.env.APPROVAL_AUTODECIDE !== "0",
  // Auth dashboard: kosong = mode terbuka khusus localhost (dev laptop).
  adminPassword: process.env.ADMIN_PASSWORD || "",
  sessionDays: num("SESSION_DAYS", 7) || 7,
  // Workspace: rumah semua project (tambah via link repo / upload zip).
  workspaceDir: process.env.WORKSPACE_DIR || "./workspace",
  projectMaxMb: num("PROJECT_MAX_MB", 50) || 50,
  gitBin: process.env.GIT_BIN || "git",
  gitTimeoutSeconds: num("GIT_TIMEOUT_SECONDS", 180) || 180,
  // Agen LangGraph: plan→implement→review loop. 0 = mode single-shot lama.
  graphEnabled: process.env.GRAPH_ENABLED !== "0",
  graphMaxRounds: num("GRAPH_MAX_ROUNDS", 3) || 3,
};

export const resetMs = () => config.claudeResetHours * 3600_000;
