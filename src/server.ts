// Web dashboard: file statis public/ (hasil build Svelte) + API JSON.
// Auth: ADMIN_PASSWORD wajib untuk akses non-localhost; tanpa password hanya
// localhost yang dilayani (mode dev). Sesi via cookie HttpOnly / Bearer.
import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { AltheaState } from "./state.js";
import { config } from "./config.js";
import { pushTask, pushFollowup, resolveApproval, cancelTask } from "./workflow.js";
import {
  killRunning, setBrainOverride, effectiveBrain,
  normalizeEffort, normalizeModel, BRAIN_EFFORTS,
} from "./claude.js";
import { logEvent } from "./state.js";
import {
  addFromRepo, addFromZip, addBlank, addPrd, listProjects, removeProject, projectDir,
  listFiles, readProjectFile, projectDiff, detectStack,
} from "./projects.js";
import {
  createPreviewManager, readPreviewFile, resolveCommand as resolvePreviewCommand,
  isStaticDir,
} from "./preview.js";
import {
  startPipelineAuto, pausePipeline, resumePipeline, cancelPipeline,
  pipelineOnFail, pipelineOnCancel,
} from "./pipeline.js";
import { getMetrics, checkBrain } from "./metrics.js";
import { listServers, syncProjectMcps, mcpOverview } from "./mcp.js";
import { goSleep, forceWake } from "./sleeper.js";
import { buildReport } from "./report.js";
import {
  createStore, createSession, validateSession, destroySession,
  verifyPassword, loginAllowed, recordLogin, isLoopback,
} from "./auth.js";

const PUBLIC_DIR = "public";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function json(res: ServerResponse, obj: unknown, code = 200): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => { b += String(d); if (b.length > 1_000_000) req.destroy(); });
    req.on("end", () => resolve(b));
  });
}

function bodyRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > maxBytes) { req.destroy(); reject(new Error("badan request melebihi batas")); return; }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

interface UploadedFile { field: string; fileName: string; data: Buffer; }

/** Parser multipart/form-data minimal (tanpa lib): kembalikan fields + file. */
export function parseMultipart(buf: Buffer, contentType: string): { fields: Record<string, string>; files: UploadedFile[] } {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!m) throw new Error("bukan multipart");
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];
  let start = buf.indexOf(sep);
  while (start >= 0) {
    const headEnd = buf.indexOf("\r\n\r\n", start);
    const next = buf.indexOf(sep, start + sep.length);
    if (headEnd < 0 || next < 0) break;
    const head = buf.subarray(start + sep.length, headEnd).toString("latin1");
    const data = buf.subarray(headEnd + 4, next - 2); // potong CRLF akhir
    const disp = head.match(/name="([^"]*)"(?:;\s*filename="([^"]*)")?/);
    if (disp) {
      if (disp[2] !== undefined) files.push({ field: disp[1], fileName: disp[2], data });
      else fields[disp[1]] = data.toString("utf8");
    }
    start = next;
    if (buf.subarray(next, next + sep.length + 2).toString() === sep.toString() + "--") break;
  }
  return { fields, files };
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/** Sajikan file statis; tolak path traversal keluar public/. */
function serveStatic(urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const full = normalize(join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const ext = full.slice(full.lastIndexOf("."));
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600",
  });
  res.end(readFileSync(full));
  return true;
}

/** Pecah path /api/projects/:name<MARKER><rest>; null bila tak cocok. */
function splitProjectSub(path: string, marker: string): [string, string] | null {
  const pre = "/api/projects/";
  if (!path.startsWith(pre)) return null;
  const rest = path.slice(pre.length);
  const i = rest.indexOf(marker);
  if (i < 0) return null;
  return [decodeURIComponent(rest.slice(0, i)), rest.slice(i + marker.length)];
}

/** Teruskan request ke server dev project di localhost:port (untuk iframe preview). */
function proxyToPort(req: IncomingMessage, res: ServerResponse, port: number, target: string): void {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.connection;
  const up = proxyRequest(
    { host: "127.0.0.1", port, path: target, method: req.method || "GET", headers, timeout: 30_000 },
    (upRes) => {
      const h = { ...upRes.headers };
      // Boleh di-iframe dashboard: buang header anti-framing milik upstream.
      delete h["content-security-policy"];
      delete h["x-frame-options"];
      res.writeHead(upRes.statusCode || 502, h);
      upRes.pipe(res);
    },
  );
  up.on("timeout", () => {
    up.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "preview timeout" }));
    }
  });
  up.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "preview tak merespons — cek status/log" }));
    }
  });
  req.pipe(up);
}

export function startServer(s: AltheaState, save: () => void, port: number, host: string): void {
  const store = createStore();
  const preview = createPreviewManager({ basePort: config.previewBasePort });
  const haltPreview = () => preview.stopAll();
  process.on("SIGINT", haltPreview);
  process.on("SIGTERM", haltPreview);
  setBrainOverride({ model: s.brain?.model, effort: s.brain?.effort }); // override dashboard dari state
  const authRequired = config.adminPassword.length > 0;
  const sessionTtlMs = config.sessionDays * 86_400_000;

  const authorized = (req: IncomingMessage): boolean => {
    if (!authRequired) {
      const ip = req.socket.remoteAddress || "";
      return isLoopback(ip); // tanpa password: localhost saja
    }
    const now = Date.now();
    return validateSession(store, bearer(req) || cookies(req).althea_token || "", now);
  };

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const path = url.pathname;
    try {
      // Publik: meta (flag auth + batas eskalasi + jam server) & login/logout.
      if (req.method === "GET" && path === "/api/meta") {
        return json(res, {
          authRequired,
          approvalWebMinutes: config.approvalWebMinutes,
          approvalTelegramMinutes: config.approvalTelegramMinutes,
          approvalAutodecide: config.approvalAutodecide,
          projectMaxMb: config.projectMaxMb,
          dryRun: config.claudeDryRun,
          loopSeconds: config.loopSeconds,
          graphEnabled: config.graphEnabled,
          graphMaxRounds: config.graphMaxRounds,
          brain: await checkBrain(effectiveBrain().bin),
          now: new Date().toISOString(),
        });
      }
      if (req.method === "POST" && path === "/api/login") {
        const ip = req.socket.remoteAddress || "unknown";
        const now = Date.now();
        if (!loginAllowed(store, ip, now)) {
          return json(res, { error: "terlalu banyak gagal, coba lagi 1 menit" }, 429);
        }
        const { password } = JSON.parse((await body(req)) || "{}");
        const ok = authRequired && verifyPassword(String(password || ""), config.adminPassword);
        recordLogin(store, ip, ok, now);
        if (!ok) return json(res, { error: authRequired ? "password salah" : "login mati (tanpa ADMIN_PASSWORD)" }, 401);
        const token = createSession(store, now, sessionTtlMs);
        res.setHeader("set-cookie",
          `althea_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${config.sessionDays * 86400}`);
        return json(res, { ok: true });
      }
      if (req.method === "POST" && path === "/api/logout") {
        destroySession(store, bearer(req) || cookies(req).althea_token || "");
        res.setHeader("set-cookie", "althea_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        return json(res, { ok: true });
      }

      // Dashboard SPA publik (form login ada di dalamnya; data tetap privat).
      if (path === "/" || !path.startsWith("/api/")) {
        if (!serveStatic(path === "/" ? "/" : path, res)) {
          // Fallback SPA: route tak dikenal → index.html (bila ada).
          if (!serveStatic("/", res)) {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end("Althea hidup. API: /api/state /api/report");
          }
        }
        return;
      }

      if (!authorized(req)) return json(res, { error: "butuh login" }, 401);

      if (req.method === "GET" && path === "/api/state") return json(res, s);
      if (req.method === "GET" && path === "/api/report") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(buildReport(s));
        return;
      }
      if (req.method === "GET" && path === "/api/metrics") {
        return json(res, await getMetrics());
      }
      if (req.method === "GET" && path === "/api/brain") {
        return json(res, { ...effectiveBrain(), efforts: BRAIN_EFFORTS });
      }
      if (req.method === "PUT" && path === "/api/brain") {
        const { model, effort } = JSON.parse((await body(req)) || "{}");
        // Absen = pertahankan; string kosong = kembali ke default env/CLI.
        if (model !== undefined && typeof model !== "string") {
          return json(res, { error: "model harus string" }, 400);
        }
        if (effort !== undefined && typeof effort !== "string") {
          return json(res, { error: "effort harus string" }, 400);
        }
        if (effort !== undefined && String(effort).trim() !== "" &&
            normalizeEffort(effort) === "") {
          return json(res, { error: `effort tak dikenal (pilih: ${BRAIN_EFFORTS.join("|")})` }, 400);
        }
        if (model !== undefined) s.brain.model = normalizeModel(model);
        if (effort !== undefined) s.brain.effort = normalizeEffort(effort);
        setBrainOverride({ model: s.brain.model, effort: s.brain.effort });
        logEvent(s, `otak ← dashboard: model=${s.brain.model || "default"} effort=${s.brain.effort || "default"}`);
        save();
        return json(res, { ok: true, brain: effectiveBrain(), applies: "next-spawn" });
      }
      if (req.method === "POST" && path === "/api/tasks") {
        const { title, prompt, project } = JSON.parse((await body(req)) || "{}");
        if (!prompt) return json(res, { error: "prompt wajib" }, 400);
        if (project && !projectDir(String(project))) {
          return json(res, { error: "nama project tidak valid" }, 400);
        }
        const t = pushTask(s, String(title || "tugas web"), String(prompt), "via web",
          project ? String(project) : undefined);
        forceWake(s, "tugas web baru");
        save();
        return json(res, t);
      }
      if (req.method === "GET" && path === "/api/projects") {
        return json(res, listProjects(s));
      }
      if (req.method === "POST" && path === "/api/projects") {
        const { name, repoUrl, prompt } = JSON.parse((await body(req)) || "{}");
        if (!name) return json(res, { error: "name wajib" }, 400);
        const url = String(repoUrl || "").trim();
        const goal = String(prompt || "").trim();
        const r = url
          ? await addFromRepo(s, String(name), url)
          : await addBlank(s, String(name), goal);
        if (!r.ok) return json(res, { error: r.error }, 400);
        // prompt = kerja otonom: susun PRD (atau langsung MVP bila PRD.md ada) dst.
        if (goal) {
          startPipelineAuto(s, String(name), goal);
          forceWake(s, `pipeline ${name}`);
        }
        save();
        return json(res, r.project);
      }
      if (req.method === "POST" && path === "/api/projects/prd") {
        const maxBytes = 2 * 1024 * 1024 + 64 * 1024;
        let raw: Buffer;
        try {
          raw = await bodyRaw(req, maxBytes);
        } catch {
          return json(res, { error: "PRD melebihi batas 2 MB" }, 413);
        }
        let up;
        try {
          up = parseMultipart(raw, req.headers["content-type"] || "");
        } catch {
          return json(res, { error: "body bukan multipart valid" }, 400);
        }
        const name = (up.fields.name || "").trim();
        const goal = (up.fields.prompt || "").trim();
        const file = up.files.find((f) => f.field === "file");
        if (!name || !file) return json(res, { error: "field name + file wajib" }, 400);
        if (!/\.(md|markdown|txt)$/i.test(file.fileName)) {
          return json(res, { error: "hanya file .md / .markdown / .txt" }, 400);
        }
        const r = await addPrd(s, name, file.fileName, file.data);
        if (!r.ok) return json(res, { error: r.error }, 400);
        startPipelineAuto(s, name, goal || `wujudkan PRD ${file.fileName}`);
        forceWake(s, `pipeline ${name}`);
        save();
        return json(res, r.project);
      }
      if (req.method === "POST" && path === "/api/projects/upload") {
        const maxBytes = config.projectMaxMb * 1024 * 1024 + 1024 * 1024;
        let raw: Buffer;
        try {
          raw = await bodyRaw(req, maxBytes);
        } catch {
          return json(res, { error: `upload melebihi batas ${config.projectMaxMb} MB` }, 413);
        }
        let up;
        try {
          up = parseMultipart(raw, req.headers["content-type"] || "");
        } catch {
          return json(res, { error: "body bukan multipart valid" }, 400);
        }
        const name = (up.fields.name || "").trim();
        const goal = (up.fields.prompt || "").trim();
        const file = up.files.find((f) => f.field === "file");
        if (!name || !file) return json(res, { error: "field name + file wajib" }, 400);
        if (!/\.zip$/i.test(file.fileName)) return json(res, { error: "hanya file .zip" }, 400);
        const r = addFromZip(s, name, file.fileName, file.data);
        if (!r.ok) return json(res, { error: r.error }, 400);
        if (goal) {
          startPipelineAuto(s, name, goal);
          forceWake(s, `pipeline ${name}`);
        }
        save();
        return json(res, r.project);
      }
      if (req.method === "DELETE" && path.startsWith("/api/projects/")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length));
        const r = removeProject(s, name);
        if (!r.ok) return json(res, { error: r.error }, 400);
        preview.stop(name); // hapus project → matikan previewnya sekalian
        save();
        return json(res, { ok: true });
      }
      // Preview statis: /api/projects/:name/preview-file/<rel> (same-origin untuk iframe).
      if (req.method === "GET") {
        const sp = splitProjectSub(path, "/preview-file/");
        if (sp) {
          const dir = projectDir(sp[0]);
          if (!dir || !existsSync(dir)) return json(res, { error: "project tak dikenal" }, 404);
          const f = readPreviewFile(dir, sp[1] || "index.html");
          if (!f.ok) return json(res, { error: f.error }, 404);
          res.writeHead(200, {
            "content-type": f.mime,
            "cache-control": (f.mime || "").startsWith("text/html") ? "no-store" : "public, max-age=60",
          });
          res.end(f.data);
          return;
        }
      }
      // Proxy ke server dev project: /api/projects/:name/app/<rest> (same-origin untuk iframe).
      {
        const sp = splitProjectSub(path, "/app/");
        if (sp) {
          const dir = projectDir(sp[0]);
          if (!dir || !existsSync(dir)) return json(res, { error: "project tak dikenal" }, 404);
          const pport = preview.portOf(sp[0]);
          if (!pport) return json(res, { error: "preview belum jalan — tekan [jalankan] dulu" }, 409);
          proxyToPort(req, res, pport, "/" + sp[1] + url.search);
          return;
        }
      }
      if (req.method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/preview")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/preview".length));
        const dir = projectDir(name);
        if (!dir || !existsSync(dir)) return json(res, { error: "project tak dikenal" }, 404);
        const p = s.projects.find((x) => x.name === name);
        return json(res, {
          ...(await preview.status(name, dir, detectStack(dir), p?.previewCmd || "")),
          savedCmd: p?.previewCmd || "",
          isStatic: isStaticDir(dir),
        });
      }
      if (req.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/preview")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/preview".length));
        const dir = projectDir(name);
        if (!dir || !existsSync(dir)) return json(res, { error: "project tak dikenal" }, 404);
        const p = s.projects.find((x) => x.name === name);
        const { action, cmd } = JSON.parse((await body(req)) || "{}");
        if (action === "stop") {
          const stopped = preview.stop(name);
          save();
          return json(res, { ok: true, stopped });
        }
        if (action !== "start") return json(res, { error: "action: start|stop" }, 400);
        if (typeof cmd === "string" && cmd.trim()) {
          if (p) p.previewCmd = cmd.trim().slice(0, 500);
        }
        const finalCmd = resolvePreviewCommand(detectStack(dir), p?.previewCmd || "");
        if (!finalCmd) {
          save();
          return json(res, {
            error: "belum ada command untuk stack ini — isi command preview dulu (mis. \"go run .\" atau \"npm run dev\")",
          }, 400);
        }
        const info = await preview.start(name, dir, finalCmd);
        save();
        return json(res, { ok: info.state !== "failed", ...info });
      }
      if (req.method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/diff")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/diff".length));
        return json(res, await projectDiff(name));
      }
      if (req.method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/files")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/files".length));
        const r = listFiles(name);
        if (!r.ok) return json(res, { error: r.error }, 400);
        return json(res, r.files);
      }
      if (req.method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/file")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/file".length));
        const r = readProjectFile(name, url.searchParams.get("path") || "");
        if (!r.ok) return json(res, { error: r.error }, 400);
        return json(res, { path: url.searchParams.get("path"), content: r.content });
      }
      if (req.method === "POST" && path.startsWith("/api/tasks/") && path.endsWith("/cancel")) {
        const id = decodeURIComponent(path.slice("/api/tasks/".length, -"/cancel".length));
        killRunning(); // hentikan proses bila yang berjalan
        const ok = cancelTask(s, id);
        if (ok) {
          pipelineOnCancel(s, id); // tugas fase → pipeline ikut jeda
          forceWake(s, `batal ${id}`);
        }
        save();
        return json(res, { ok });
      }
      if (req.method === "POST" && path.startsWith("/api/tasks/") && path.endsWith("/followup")) {
        const id = decodeURIComponent(path.slice("/api/tasks/".length, -"/followup".length));
        const { prompt } = JSON.parse((await body(req)) || "{}");
        const t = pushFollowup(s, String(id), String(prompt || ""));
        if (!t) return json(res, { error: "tugas induk tak ada / prompt kosong" }, 400);
        forceWake(s, `lanjutan ${id}`);
        save();
        return json(res, t);
      }
      if (req.method === "POST" && path.startsWith("/api/projects/") && path.endsWith("/pipeline")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/pipeline".length));
        const { action } = JSON.parse((await body(req)) || "{}");
        const p = s.projects.find((x) => x.name === name);
        if (!p?.pipeline) return json(res, { error: "project tanpa pipeline" }, 404);
        let ok = false;
        if (action === "pause") ok = pausePipeline(s, name);
        else if (action === "resume") { resumePipeline(s, name); ok = true; forceWake(s, `pipeline ${name}`); }
        else if (action === "cancel") { ok = cancelPipeline(s, name); if (ok) killRunning(); }
        else return json(res, { error: "action: pause|resume|cancel" }, 400);
        save();
        return json(res, { ok, pipeline: p.pipeline });
      }
      if (req.method === "GET" && path.startsWith("/api/projects/") && path.endsWith("/mcps")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/mcps".length));
        const p = s.projects.find((x) => x.name === name);
        if (!p) return json(res, { error: "project tak dikenal" }, 404);
        return json(res, mcpOverview(p.mcps || []));
      }
      if (req.method === "PUT" && path.startsWith("/api/projects/") && path.endsWith("/mcps")) {
        const name = decodeURIComponent(path.slice("/api/projects/".length, -"/mcps".length));
        const p = s.projects.find((x) => x.name === name);
        if (!p) return json(res, { error: "project tak dikenal" }, 404);
        const { mcps } = JSON.parse((await body(req)) || "{}");
        if (!Array.isArray(mcps)) return json(res, { error: "mcps harus array id" }, 400);
        const known = new Set(listServers().map((d) => d.id));
        const clean = [...new Set(mcps.map(String))].filter((id) => known.has(id));
        if (clean.length !== new Set(mcps.map(String)).size) {
          return json(res, { error: `id MCP tak dikenal (pilih: ${[...known].join("|")})` }, 400);
        }
        p.mcps = clean;
        let synced = null;
        try {
          synced = syncProjectMcps(clean);
          if (!synced.ok) logEvent(s, `mcp sync @${name} gagal: ${synced.error}`);
          else if (synced.changed) logEvent(s, `mcp sync @${name}: ${clean.join(",") || "mati semua"}`);
        } catch (e) {
          logEvent(s, `mcp sync @${name} gagal: ${String(e)}`);
        }
        save();
        return json(res, { ok: true, ...mcpOverview(clean), synced });
      }
      if (req.method === "GET" && path.startsWith("/api/tasks/") && path.endsWith("/log")) {
        const id = decodeURIComponent(path.slice("/api/tasks/".length, -"/log".length));
        const t = s.stack.find((x) => x.id === id);
        if (!t) return json(res, { error: "tugas tidak ada" }, 404);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let idx = 0;
        const send = (): boolean => {
          const lines = s.logs[id] || [];
          const fresh = lines.slice(idx);
          idx = lines.length;
          const terminal = t.status === "done" || t.status === "failed";
          res.write(`data: ${JSON.stringify({ lines: fresh, done: terminal })}\n\n`);
          return terminal;
        };
        send();
        const timer = setInterval(() => {
          try {
            if (send()) { clearInterval(timer); res.end(); }
          } catch { clearInterval(timer); }
        }, 1000);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (req.method === "POST" && path === "/api/approve") {
        const { id, ok, note } = JSON.parse((await body(req)) || "{}");
        const done = resolveApproval(s, String(id), Boolean(ok), String(note || ""), "admin-web");
        if (done && ok) forceWake(s, `approval web ${id}`);
        if (done && !ok) pipelineOnFail(s, String(id)); // tolak tugas fase → pipeline gagal
        save();
        return json(res, { ok: done });
      }
      if (req.method === "POST" && path === "/api/sleep") {
        const { minutes } = JSON.parse((await body(req)) || "{}");
        const until = goSleep(s, Number(minutes) || 60);
        save();
        return json(res, { sleepUntil: until });
      }
      if (req.method === "POST" && path === "/api/wake") {
        forceWake(s, "tombol web bangun");
        save();
        return json(res, { awake: true });
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("tidak ada");
    } catch (e) {
      json(res, { error: String(e).slice(0, 300) }, 500);
    }
  });
  srv.listen(port, host, () => console.log(
    `[althea] web http://${host}:${port} · auth: ${authRequired ? "password" : "TERBUKA localhost saja (isi ADMIN_PASSWORD untuk deploy)"}`
  ));
}
