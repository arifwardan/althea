// PostgreSQL BERSAMA untuk semua app buatan.
// Aturan: Althea TAK PERNAH menyuruh AI menginstall PostgreSQL — pakai server
// lokal yang sudah terinstall. Username default "althea", password default
// "password" (diubah admin lewat .env: DB_PASSWORD), dan role dibuat di
// server (best-effort, idempotent). Kredensial yang sama disuntik ke prompt
// tiap fase pipeline, jadi setiap app yang dibuat memakainya.
import { execFile } from "node:child_process";
import { config } from "./config.js";

/** Nama role valid sebagai identifier PostgreSQL tanpa kutip (huruf/angka/_, mulai huruf). */
const USER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Password bawaan bila DB_PASSWORD kosong/tak diisi di .env. */
export const DEFAULT_DB_PASSWORD = "password";

/** Password aktif: DB_PASSWORD di .env (env) > default. Berlaku setelah restart. */
export function dbPassword(): string {
  return (config.dbPassword || "").trim() || DEFAULT_DB_PASSWORD;
}

/** SQL idempotent: buat role bila belum ada; kalau sudah, sinkronkan password + CREATEDB. */
export function roleSql(user: string, password: string): string {
  if (!USER_RE.test(user)) throw new RangeError(`invalid DB_USER "${user}" (use letters/digits/_, max 63)`);
  const q = (s: string) => s.replace(/'/g, "''");
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${q(user)}') ` +
    `THEN CREATE ROLE ${user} LOGIN PASSWORD '${q(password)}' CREATEDB; ` +
    `ELSE ALTER ROLE ${user} WITH LOGIN PASSWORD '${q(password)}' CREATEDB; END IF; END $$;`;
}

export interface RoleResult { ok: boolean; how?: string; error?: string; manual?: string }

function psql(args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    execFile("psql", args, { timeout: 8000, env: { ...process.env, ...extraEnv } }, (err, _out, stderr) => {
      // ENOENT (psql tak ada) maupun error SQL sama → coba metode berikutnya.
      resolve({ code: err ? 1 : 0, err: err ? `${(err as { code?: string }).code || "error"} ${stderr || err.message}`.trim() : "" });
    });
  });
}

/**
 * Pastikan role DB ada di pgsql lokal (best-effort, tak memblokir boot).
 * Urutan: VERIFIKASI sebagai role itu sendiri (PGPASSWORD — bila sudah ada
 * dengan password kita, selesai tanpa butuh hak istimewa) → TCP sebagai
 * postgres (trust/.pgpass/PG* env) → socket lokal (peer auth) → sudo -n.
 * Semua gagal → error (password diredaksi) + perintah manual tanpa password.
 */
export async function ensureDbRole(): Promise<RoleResult> {
  const user = config.dbUser.trim();
  const password = dbPassword();
  let sql: string;
  try {
    sql = roleSql(user, password);
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
  // Password custom dirahasiakan dari log; default "password" bukan rahasia
  // (terdokumentasi di .env.example) supaya pesan error tetap terbaca.
  const redact = (s: string) =>
    password && password !== DEFAULT_DB_PASSWORD ? s.split(password).join("***") : s;
  const verify = ["-U", user, "-h", config.dbHost, "-p", String(config.dbPort), "-d", "postgres", "-c", "select 1"];
  const tcp = ["-U", "postgres", "-h", config.dbHost, "-p", String(config.dbPort), "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql];
  const socket = ["-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql];
  const attempts: Array<{ how: string; run: () => Promise<{ code: number; err: string }> }> = [
    { how: `verified as ${user}`, run: () => psql(verify, { PGPASSWORD: password }) },
    { how: "psql tcp", run: () => psql(tcp) },
    { how: "psql socket", run: () => psql(socket) },
    {
      how: "sudo -u postgres",
      run: () => new Promise((resolve) => {
        execFile("sudo", ["-n", "-u", "postgres", "psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
          { timeout: 8000, env: process.env }, (err, _out, stderr) => {
            resolve({ code: err ? 1 : 0, err: err ? `${(err as { code?: string }).code || "error"} ${stderr || err.message}`.trim() : "" });
          });
      }),
    },
  ];
  const errors: string[] = [];
  for (const a of attempts) {
    const r = await a.run();
    if (r.code === 0) return { ok: true, how: a.how };
    errors.push(redact(`${a.how}: ${r.err}`.slice(0, 300)));
  }
  // Perintah manual TANPA password (diambil dari .env saat dijalankan) —
  // aman untuk log/notifikasi.
  const manual = [
    `PW=$(grep '^DB_PASSWORD=' .env | cut -d= -f2); PW=\${PW:-${DEFAULT_DB_PASSWORD}}  # .env kosong → default`,
    `sudo -u postgres psql -c "CREATE ROLE ${user} LOGIN PASSWORD '$PW' CREATEDB;"  # "already exists" = fine`,
    `sudo -u postgres psql -c "ALTER ROLE ${user} WITH LOGIN PASSWORD '$PW' CREATEDB;"  # sync password`,
  ].join("\n");
  return { ok: false, error: redact(`${errors.join(" | ")} — is PostgreSQL running + client (psql) installed?`), manual };
}

/**
 * Baris instruksi DB untuk prompt fase pipeline ("" bila bukan PostgreSQL):
 * pakai server lokal yang sudah terinstall + kredensial bersama Althea.
 */
export function dbInstructions(db: string): string {
  if (String(db ?? "").trim().toLowerCase() !== "postgresql") return "";
  const port = config.dbPort || 5432;
  return [
    `Database: use the EXISTING local PostgreSQL server (already installed at ${config.dbHost}:${port}) — NEVER install, download, or start PostgreSQL yourself (no apt/brew/initdb).`,
    `Shared Althea DB credentials — use exactly these and put them in the app's .env: DB_HOST=${config.dbHost} DB_PORT=${port} DB_USER=${config.dbUser} DB_PASSWORD=${dbPassword()}.`,
    `Create only the app database (CREATE DATABASE ...); role "${config.dbUser}" already exists with CREATEDB — do NOT create roles/users and do NOT change this password.`,
  ].join(" ");
}
