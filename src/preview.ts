// Preview aplikasi project: jalankan server dev di port terkelola (9111+),
// atau sajikan file statis bila project berupa HTML polos.
// Dashboard menampilkan via iframe same-origin (/app/* proxy, /preview-file/* statis).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep, normalize, extname } from "node:path";
import { connect, createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";

/** Apakah folder layak preview statis (HTML polos tanpa server). */
export function isStaticDir(dir: string): boolean {
  return existsSync(join(dir, "index.html")) && !existsSync(join(dir, "package.json"));
}

/** Command default per stack. {port} diganti port alokasi. null = wajib isi manual. */
export function defaultCommand(stack: string): string | null {
  if (stack === "node") return "npm run dev"; // PORT+HOST diset via env
  if (stack === "python") return "python3 -m http.server {port} --bind 127.0.0.1";
  return null; // go/generic: butuh command kustom (mis. "go run .")
}

export function resolveCommand(stack: string, override?: string): string {
  const o = (override || "").trim().slice(0, 500);
  if (o) return o;
  return defaultCommand(stack) || "";
}

/** Pecah command ala shell: hormati kutip satu/dua. */
export function splitCmd(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; }
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Klaim satu port bebas di [base, base+89]; null bila penuh. */
export function claimPort(base: number, used: Set<number>): Promise<number | null> {
  const tryOne = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (used.has(port)) return resolve(false);
      const s = createNetServer();
      s.once("error", () => resolve(false));
      s.listen(port, "127.0.0.1", () => {
        s.close(() => resolve(true));
      });
    });
  (async () => undefined)();
  return (async () => {
    for (let p = base; p < base + 90; p++) {
      if (used.has(p)) continue;
      if (await tryOne(p)) return p;
    }
    return null;
  })();
}

/** Apakah ada yang listen di port (cepat, untuk kesiapan/reachable). */
export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    const done = (v: boolean) => {
      try { sock.destroy(); } catch { /* abaikan */ }
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => { clearTimeout(t); done(true); });
    sock.once("error", () => { clearTimeout(t); done(false); });
  });
}

const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
};

/** Path file aman di dalam dir; null bila traversal / bukan file. */
export function resolvePreviewPath(dir: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const clean = decoded.split("?")[0].replace(/\\/g, "/");
  const full = normalize(join(resolve(dir), clean || "index.html"));
  const root = resolve(dir);
  if (full !== root && !full.startsWith(root + sep)) return null;
  try {
    if (!statSync(full).isFile()) {
      // izinkan prefix folder → index.html (mis. /about/ → /about/index.html)
      const idx = join(full, "index.html");
      if (!statSync(idx).isFile()) return null;
      return idx;
    }
  } catch {
    return null;
  }
  return full;
}

export function previewMime(full: string): string {
  return PREVIEW_MIME[extname(full).toLowerCase()] || "application/octet-stream";
}

export function readPreviewFile(dir: string, rel: string): { ok: boolean; full?: string; mime?: string; data?: Buffer; error?: string } {
  const full = resolvePreviewPath(dir, rel);
  if (!full) return { ok: false, error: "file tak ditemukan" };
  try {
    return { ok: true, full, mime: previewMime(full), data: readFileSync(full) };
  } catch {
    return { ok: false, error: "gagal baca file" };
  }
}

export type PreviewState = "stopped" | "starting" | "running" | "failed";

export interface PreviewInfo {
  state: PreviewState;
  mode: "static" | "server" | null;
  port: number | null;
  cmd: string | null;
  pid: number | null;
  startedAt: string | null;
  reachable: boolean | null;
  error: string | null;
  url: string | null; // path same-origin untuk iframe
  logs: string[];
}

interface Rec {
  child: ChildProcess | null; // mode server
  http: HttpServer | null; // mode static: penyaji file dalam proses
  port: number | null;
  cmd: string | null;
  dir: string;
  mode: "static" | "server";
  state: PreviewState;
  startedAt: string | null;
  reachable: boolean | null;
  error: string | null;
  logs: string[];
}

export interface PreviewManagerOpts {
  basePort?: number;
  maxProcs?: number;
  readyTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * URL untuk iframe/"buka tab".
 * Selalu LANGSUNG ke port preview (bukan prefix /app/): tiap preview punya
 * origin sendiri sehingga aset ber-path absolut ("/assets/...", "/_next/..."),
 * fetch, module script, dan storage app modern tetap jalan — sekaligus
 * terisolasi dari origin dashboard. Fallback path hanya bila port belum ada.
 */
export function previewUrlFor(name: string, mode: "static" | "server", port: number | null): string {
  if (port !== null) return `http://127.0.0.1:${port}/`;
  const n = encodeURIComponent(name);
  return `/api/projects/${n}/preview-file/`;
}

export function createPreviewManager(opts: PreviewManagerOpts = {}) {
  const basePort = opts.basePort || 9111;
  const maxProcs = opts.maxProcs || 8;
  const readyTimeoutMs = opts.readyTimeoutMs || 12_000;
  const recs = new Map<string, Rec>();
  const usedPorts = new Set<number>();

  const stopped = (): PreviewInfo => ({
    state: "stopped", mode: null, port: null, cmd: null, pid: null,
    startedAt: null, reachable: null, error: null, url: null, logs: [],
  });

  function pushLog(rec: Rec, line: string): void {
    for (const ln of String(line).split("\n")) {
      const t = ln.replace(/\r$/, "").slice(0, 1000);
      if (!t.trim()) continue;
      rec.logs.push(t);
      if (rec.logs.length > 200) rec.logs = rec.logs.slice(-200);
    }
  }

  function toInfo(name: string, rec: Rec): PreviewInfo {
    return {
      state: rec.state, mode: rec.mode, port: rec.port, cmd: rec.cmd,
      pid: rec.child?.pid || null, startedAt: rec.startedAt,
      reachable: rec.mode === "static" ? true : rec.reachable,
      error: rec.error, url: previewUrlFor(name, rec.mode, rec.port), logs: [...rec.logs],
    };
  }

  function killChild(child: ChildProcess | null): void {
    if (!child || child.killed) return;
    try { child.kill("SIGTERM"); } catch { /* sudah mati */ }
    setTimeout(() => {
      try { if (!child.killed) child.kill("SIGKILL"); } catch { /* abaikan */ }
    }, 5000);
  }

  async function start(name: string, dir: string, cmd: string): Promise<PreviewInfo> {
    stop(name);
    const parts = splitCmd(cmd);
    if (!parts.length) {
      return { ...stopped(), state: "failed", error: "command kosong" };
    }
    if (recs.size >= maxProcs) {
      return { ...stopped(), state: "failed", error: `terlalu banyak preview jalan (maks ${maxProcs})` };
    }
    const port = await claimPort(basePort, usedPorts);
    if (port === null) {
      return { ...stopped(), state: "failed", error: "port preview 9111–9200 penuh" };
    }
    usedPorts.add(port);
    const finalCmd = cmd.split("{port}").join(String(port));
    const fp = splitCmd(finalCmd);
    const rec: Rec = {
      child: null, http: null, port, cmd: finalCmd, dir, mode: "server",
      state: "starting", startedAt: new Date().toISOString(),
      reachable: false, error: null, logs: [],
    };
    recs.set(name, rec);
    pushLog(rec, `$ ${finalCmd}  (port ${port})`);
    let child: ChildProcess;
    try {
      child = spawn(fp[0], fp.slice(1), {
        cwd: dir, shell: false,
        // PORT+HOST umum; HOSTNAME untuk Next.js ("next dev" mengabaikan HOST).
        env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HOSTNAME: "127.0.0.1" },
      });
    } catch (e) {
      rec.state = "failed";
      rec.error = `gagal spawn: ${String(e)}`;
      usedPorts.delete(port);
      return toInfo(name, rec);
    }
    rec.child = child;
    child.stdout?.on("data", (d) => pushLog(rec, String(d)));
    child.stderr?.on("data", (d) => pushLog(rec, String(d)));
    child.on("error", (e) => {
      pushLog(rec, `spawn error: ${String(e)}`);
      if (rec.state === "starting" || rec.state === "running") {
        rec.state = "failed";
        rec.error = `proses tak bisa jalan: ${(e as { code?: string })?.code || String(e)} — cek command`;
      }
    });
    child.on("close", (code) => {
      pushLog(rec, `[keluar kode ${code}]`);
      usedPorts.delete(port);
      if (rec.state === "starting" || rec.state === "running") {
        rec.state = "failed";
        rec.error = rec.error || `proses mati sendiri (kode ${code}) — cek log`;
      }
    });
    // Tunggu port merespons; proses hidup tapi port diam = running + reachable=false.
    const t0 = Date.now();
    while (Date.now() - t0 < readyTimeoutMs) {
      if (rec.state === "failed") return toInfo(name, rec);
      if (await portOpen(port, 400)) {
        rec.state = "running";
        rec.reachable = true;
        return toInfo(name, rec);
      }
      await sleep(300);
    }
    if (rec.state === "starting") {
      rec.state = "running"; // proses hidup; mungkin bind lambat / port lain
      rec.reachable = false;
    }
    return toInfo(name, rec);
  }

  function stop(name: string): boolean {
    const rec = recs.get(name);
    if (!rec) return false;
    killChild(rec.child);
    if (rec.http) {
      // Putuskan koneksi keep-alive dulu: tanpa ini close() menunggu
      // browser/fetch menutup koneksi dan port tak kunjung lepas.
      try { rec.http.closeAllConnections(); } catch { /* abaikan */ }
      try { rec.http.close(); } catch { /* abaikan */ }
      rec.http = null;
    }
    if (rec.port !== null) usedPorts.delete(rec.port);
    recs.delete(name);
    return true;
  }

  function stopAll(): void {
    for (const name of [...recs.keys()]) stop(name);
  }

  /** Port proses yang jalan; null bila tidak ada. */
  function portOf(name: string): number | null {
    const rec = recs.get(name);
    if (!rec || rec.mode !== "server" || rec.state === "failed") return null;
    return rec.port;
  }

  /** Sajikan folder statis di port sendiri (origin terpisah dari dashboard). */
  async function startStatic(name: string, dir: string): Promise<PreviewInfo> {
    stop(name);
    if (recs.size >= maxProcs) {
      return { ...stopped(), state: "failed", error: `terlalu banyak preview jalan (maks ${maxProcs})` };
    }
    const port = await claimPort(basePort, usedPorts);
    if (port === null) {
      return { ...stopped(), state: "failed", error: "port preview 9111–9200 penuh" };
    }
    const rec: Rec = {
      child: null, http: null, port, cmd: null, dir, mode: "static",
      state: "starting", startedAt: new Date().toISOString(),
      reachable: false, error: null, logs: [],
    };
    recs.set(name, rec);
    const server = createHttpServer((req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("hanya GET");
        return;
      }
      const rawPath = (req.url || "/").split("?")[0];
      let f = readPreviewFile(dir, rawPath === "/" ? "index.html" : rawPath.slice(1));
      if (!f.ok && !extname(rawPath)) f = readPreviewFile(dir, "index.html"); // SPA fallback
      if (!f.ok) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("tidak ada");
        return;
      }
      res.writeHead(200, {
        "content-type": f.mime,
        "cache-control": (f.mime || "").startsWith("text/html") ? "no-store" : "public, max-age=60",
      });
      res.end(f.data);
    });
    server.on("error", (e) => {
      if (rec.state === "starting" || rec.state === "running") {
        rec.state = "failed";
        rec.error = `server statis gagal: ${String(e)}`;
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
    } catch (e) {
      rec.state = "failed";
      rec.error = `port ${port} tak bisa dipakai: ${String(e)}`;
      return toInfo(name, rec);
    }
    usedPorts.add(port);
    rec.http = server;
    rec.state = "running";
    rec.reachable = true;
    return toInfo(name, rec);
  }

  async function status(name: string, dir: string, stack: string, savedCmd?: string): Promise<PreviewInfo> {
    const rec = recs.get(name);
    if (!rec) {
      // Statis jalan otomatis (ringan, dalam proses) agar selalu bisa dibuka.
      if (isStaticDir(dir)) return startStatic(name, dir);
      return { ...stopped(), cmd: resolveCommand(stack, savedCmd) || null };
    }
    if (rec.mode === "server" && rec.state === "running" && rec.port !== null) {
      rec.reachable = await portOpen(rec.port, 400);
    }
    return toInfo(name, rec);
  }

  return { start, stop, stopAll, status, portOf, isStaticDir, resolveCommand: resolveCommand };
}
