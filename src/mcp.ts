// MCP: sambungkan project Althea ke MCP server milik muse CLI.
// Mekanisme terverifikasi: CLI membaca ~/.config/muse/settings.json dengan
// {"schema_version": 1, "mcpServers": {...}} top-level (tanpa flag exec khusus).
// Althea hanya mengelola entri miliknya (kunci "althea-<id>"); entri user lain
// tak pernah disentuh, dan file yang tak bisa diparse TAK PERNAH ditimpa.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface McpServerDef {
  id: string;
  desc: string;
  transport: "stdio" | "http";
  command?: string[]; // stdio: argv lengkap, mis. ["npx", "-y", "@playwright/mcp"]
  url?: string; // http: endpoint streamable-HTTP
  env?: Record<string, string>;
  setupHint: string; // cara menyiapkan bila belum runnable
}

const BUILTINS: McpServerDef[] = [
  {
    id: "playwright",
    desc: "Otomasi browser: buka, screenshot, dan klik app hasil generate untuk verifikasi",
    transport: "stdio",
    command: ["npx", "-y", "@playwright/mcp"],
    setupHint: "npm i -g @playwright/mcp lalu npx playwright install chromium",
  },
];

/** Server tambahan via env ALTHEA_MCP_SERVERS (JSON map id → {command|url, ...}). */
export function customServers(env: NodeJS.ProcessEnv = process.env): McpServerDef[] {
  const raw = (env.ALTHEA_MCP_SERVERS || "").trim();
  if (!raw) return [];
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return [];
    const out: McpServerDef[] = [];
    for (const [id, v] of Object.entries(o as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(id)) continue;
      const d = (v || {}) as Record<string, unknown>;
      const transport = d.transport === "http" ? "http" : "stdio";
      if (transport === "http") {
        if (typeof d.url !== "string" || !d.url) continue;
        out.push({
          id, desc: typeof d.desc === "string" ? d.desc : `MCP ${id} (kustom)`,
          transport, url: d.url, setupHint: "server HTTP kustom — pastikan URL bisa dijangkau",
        });
      } else {
        if (!Array.isArray(d.command) || !d.command.length || !d.command.every((c) => typeof c === "string")) continue;
        out.push({
          id, desc: typeof d.desc === "string" ? d.desc : `MCP ${id} (kustom)`,
          transport, command: d.command as string[], setupHint: `pastikan perintah "${(d.command as string[])[0]}" tersedia di PATH`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function listServers(env: NodeJS.ProcessEnv = process.env): McpServerDef[] {
  const seen = new Set<string>();
  const out: McpServerDef[] = [];
  for (const d of [...BUILTINS, ...customServers(env)]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    out.push(d);
  }
  return out;
}

export function findServer(id: string, env: NodeJS.ProcessEnv = process.env): McpServerDef | null {
  return listServers(env).find((d) => d.id === id) || null;
}

/** Kunci milik Althea di settings.json — entri user lain tak pernah bernama ini. */
export const ownedKey = (id: string): string => `althea-${id}`;

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "muse", "settings.json");
}

/** Entri settings.json gaya map (konvensi ekosistem Claude Code): {command, args, env} / {url}. */
export function toEntry(def: McpServerDef): Record<string, unknown> {
  if (def.transport === "http") return { url: def.url };
  const [command, ...args] = def.command || [];
  const e: Record<string, unknown> = { command };
  if (args.length) e.args = args;
  if (def.env) e.env = def.env;
  return e;
}

export interface McpMerge {
  ok: boolean;
  doc?: Record<string, unknown>;
  changed?: boolean;
  error?: string;
}

/**
 * Gabung entri milik Althea ke dokumen settings (murni, tanpa I/O).
 * owned: kunci → entri baru, atau null untuk hapus (disable).
 * Menolak bila dokumen rusak / mcpServers bukan object — takut merusak punya user.
 */
export function mergeMcpSettings(
  raw: string | null, owned: Record<string, Record<string, unknown> | null>,
): McpMerge {
  let doc: Record<string, unknown>;
  if (!raw || !raw.trim()) {
    doc = { schema_version: 1 };
  } else {
    try {
      const v: unknown = JSON.parse(raw);
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        return { ok: false, error: "settings.json bukan object — batal tulis" };
      }
      doc = v as Record<string, unknown>;
    } catch {
      return { ok: false, error: "settings.json bukan JSON valid — batal tulis" };
    }
  }
  if (doc.schema_version === undefined) doc.schema_version = 1;
  let servers = doc.mcpServers;
  if (servers === undefined) {
    servers = {};
    doc.mcpServers = servers;
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { ok: false, error: "mcpServers bukan object — batal tulis (milik user, takut merusak)" };
  }
  const rec = servers as Record<string, unknown>;
  const before = JSON.stringify(rec);
  for (const [k, v] of Object.entries(owned)) {
    if (v === null) delete rec[k];
    else rec[k] = v;
  }
  return { ok: true, doc, changed: JSON.stringify(rec) !== before };
}

export interface McpRunOpts {
  settingsFile?: string;
  run?: (cmd: string, args: string[]) => boolean; // cek runnable (bisa stub di test)
  env?: NodeJS.ProcessEnv;
}

function defaultRun(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Apakah server bisa dijalankan di mesin ini (cek ringan, bukan garansi penuh). */
export function isRunnable(def: McpServerDef, run: (cmd: string, args: string[]) => boolean = defaultRun): boolean {
  if (def.transport === "http") return true; // remote: cek koneksi dilewati
  const [cmd, ...rest] = def.command || [];
  if (!cmd) return false;
  if (cmd === "npx") {
    const pkg = rest.find((a) => !a.startsWith("-"));
    if (!pkg) return false;
    return run("npx", ["--no-install", pkg, "--version"]);
  }
  return run(cmd, ["--version"]);
}

export interface McpStatus {
  id: string;
  desc: string;
  enabled: boolean;
  present: boolean; // entri ada di settings.json
  runnable: boolean | null; // null = tak dicek (belum diaktifkan)
  setupHint: string;
}

export interface McpSync {
  ok: boolean;
  changed: boolean;
  error?: string;
  status: McpStatus[];
}

/**
 * Sinkronkan MCP project ke settings.json CLI. Tak pernah melempar;
 * kegagalan dilaporkan agar tugas tetap lanjut tanpa MCP.
 */
export function syncProjectMcps(enabledIds: string[], opts: McpRunOpts = {}): McpSync {
  const env = opts.env || process.env;
  const defs = listServers(env);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const enabled = [...new Set(enabledIds.map(String))].filter((id) => byId.has(id));
  const file = opts.settingsFile || settingsPath(env);
  const run = opts.run || defaultRun;
  let raw: string | null = null;
  try {
    if (existsSync(file)) raw = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, changed: false, error: `tak bisa baca settings: ${String(e)}`, status: [] };
  }
  const owned: Record<string, Record<string, unknown> | null> = {};
  for (const d of defs) owned[ownedKey(d.id)] = enabled.includes(d.id) ? toEntry(d) : null;
  const m = mergeMcpSettings(raw, owned);
  if (!m.ok || !m.doc) return { ok: false, changed: false, error: m.error, status: [] };
  let changed = !!m.changed;
  if (m.changed) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(m.doc, null, 2) + "\n");
    } catch (e) {
      return { ok: false, changed: false, error: `tak bisa tulis settings: ${String(e)}`, status: [] };
    }
  }
  const servers = (m.doc.mcpServers || {}) as Record<string, unknown>;
  const status = defs.map((d) => {
    const on = enabled.includes(d.id);
    return {
      id: d.id, desc: d.desc, enabled: on,
      present: ownedKey(d.id) in servers,
      runnable: on ? isRunnable(d, run) : null,
      setupHint: d.setupHint,
    };
  });
  return { ok: true, changed, status };
}

/** Ringkasan untuk dashboard/API: baca saja, tanpa menulis settings. */
export function mcpOverview(enabledIds: string[], opts: McpRunOpts = {}): { enabled: string[]; servers: McpStatus[] } {
  const env = opts.env || process.env;
  const defs = listServers(env);
  const enabled = [...new Set(enabledIds.map(String))].filter((id) => defs.some((d) => d.id === id));
  const file = opts.settingsFile || settingsPath(env);
  const run = opts.run || defaultRun;
  let servers: Record<string, unknown> = {};
  try {
    if (existsSync(file)) {
      const v: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const ms = (v as Record<string, unknown>).mcpServers;
        if (ms && typeof ms === "object" && !Array.isArray(ms)) servers = ms as Record<string, unknown>;
      }
    }
  } catch { /* tak terbaca → present=false semua */ }
  return {
    enabled,
    servers: defs.map((d) => {
      const on = enabled.includes(d.id);
      return {
        id: d.id, desc: d.desc, enabled: on,
        present: ownedKey(d.id) in servers,
        runnable: on ? isRunnable(d, run) : null,
        setupHint: d.setupHint,
      };
    }),
  };
}
