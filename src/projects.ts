// Workspace: rumah semua project. Tambah via link repo (git clone) atau
// upload zip. Nama divalidasi ketat (anti traversal), zip disaring dari
// zip-slip, dan stack terdeteksi otomatis.
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import { config } from "./config.js";
import type { AltheaState, Project } from "./state.js";
import { logEvent } from "./state.js";

/** Nama project: huruf/angka, boleh . _ - ; tanpa path. */
export function validName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}

/** URL repo yang diizinkan: https/http atau scp-style git@host:path. */
export function validRepoUrl(url: string): boolean {
  return /^(https?:\/\/[^/\s]+\/\S+|git@[A-Za-z0-9._-]+:[^\s]+\.git)$/.test(url.trim());
}

/** Path absolut folder project; null bila nama tidak valid. */
export function projectDir(name: string): string | null {
  if (!validName(name)) return null;
  const full = resolve(join(config.workspaceDir, name));
  const root = resolve(config.workspaceDir);
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

/** Deteksi stack dari file penanda. */
export function detectStack(dir: string): string {
  if (existsSync(join(dir, "package.json"))) return "node";
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "requirements.txt"))) return "python";
  return "generic";
}

/** Saring entri zip berbahaya (zip-slip / absolut / drive Windows). */
export function safeZipEntries(zip: AdmZip): string[] {
  const out: string[] = [];
  for (const e of zip.getEntries()) {
    const name = e.entryName.replace(/\\/g, "/");
    if (!name || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) continue;
    if (name.split("/").some((seg) => seg === ".." || seg === "")) {
      // izinkan trailing "/" (folder); tolak ".." dan segmen kosong tengah
      const segs = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
      if (segs.some((s) => s === ".." || s === "")) continue;
    }
    out.push(e.entryName);
  }
  return out;
}

function register(s: AltheaState, name: string, source: string): Project {
  mkdirSync(config.workspaceDir, { recursive: true });
  const dir = projectDir(name) as string;
  const stack = detectStack(dir);
  const now = new Date().toISOString();
  const prev = s.projects.findIndex((p) => p.name === name);
  const prevProj = prev >= 0 ? s.projects[prev] : null;
  const proj: Project = {
    name, source, stack, addedAt: prevProj ? prevProj.addedAt : now,
    ...(prevProj?.pipeline ? { pipeline: prevProj.pipeline } : {}),
    ...(prevProj?.mcps ? { mcps: prevProj.mcps } : {}),
    ...(prevProj?.previewCmd ? { previewCmd: prevProj.previewCmd } : {}),
  };
  if (prev >= 0) s.projects[prev] = proj;
  else s.projects.push(proj);
  logEvent(s, `project +${name} [${stack}] (${source.slice(0, 80)})`);
  return proj;
}

/** Clone repo ke workspace/<name>. Gagal → {ok:false, error}. */
export function addFromRepo(s: AltheaState, name: string, repoUrl: string): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return Promise.resolve({ ok: false, error: "nama project tidak valid" });
  if (!validRepoUrl(repoUrl)) return Promise.resolve({ ok: false, error: "URL repo tidak valid (https://… atau git@host:path.git)" });
  if (existsSync(dir)) return Promise.resolve({ ok: false, error: `folder "${name}" sudah ada` });
  mkdirSync(config.workspaceDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(config.gitBin, ["clone", "--depth", "1", repoUrl.trim(), dir], {
      timeout: config.gitTimeoutSeconds * 1000,
      shell: false,
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => resolve({ ok: false, error: `git gagal dijalankan: ${String(e).slice(0, 200)}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        resolve({ ok: false, error: `git clone gagal (exit ${code}): ${err.slice(0, 300)}` });
        return;
      }
      resolve({ ok: true, project: register(s, name, repoUrl.trim()) });
    });
  });
}

/** Ekstrak buffer zip ke workspace/<name>. */
export function addFromZip(
  s: AltheaState, name: string, fileName: string, buf: Buffer
): { ok: boolean; error?: string; project?: Project } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" sudah ada` };
  if (buf.length > config.projectMaxMb * 1024 * 1024) {
    return { ok: false, error: `zip melebihi batas ${config.projectMaxMb} MB` };
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    return { ok: false, error: "bukan file zip yang valid" };
  }
  const entries = safeZipEntries(zip);
  if (entries.length === 0) return { ok: false, error: "zip kosong / semua entri ditolak" };
  mkdirSync(dir, { recursive: true });
  try {
    // Ekstrak hanya entri aman; bungkus root tunggal (repo-zip GitHub) dirapikan.
    const norm = entries.map((e) => e.replace(/\\/g, "/"));
    const roots = new Set(norm.map((e) => e.split("/")[0]));
    const [single] = [...roots];
    // Rapikan bungkus root tunggal (zip GitHub: repo-main/...) — tapi jangan
    // strip bila zip hanya berisi file lepas di root.
    const strip = roots.size === 1 && norm.some((e) => e !== single && e.startsWith(single + "/"));
    for (const entryName of entries) {
      const entry = zip.getEntry(entryName);
      if (!entry || entry.isDirectory) continue;
      let rel = entryName.replace(/\\/g, "/");
      if (strip) rel = rel.slice(single.length + 1);
      if (!rel) continue;
      const target = resolve(join(dir, rel));
      if (target !== dir && !target.startsWith(dir + sep)) continue; // sabuk + suspender
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, entry.getData());
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `gagal ekstrak zip: ${String(e).slice(0, 200)}` };
  }
  return { ok: true, project: register(s, name, `zip:${fileName}`.slice(0, 120)) };
}

/** Git init + commit awal, best-effort (tak pernah throw): agar diff/review langsung berguna. */
export function ensureGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) => new Promise<void>((resolve) => {
    execFile(config.gitBin, args, { cwd: dir, timeout: 15_000 }, () => resolve());
  });
  return (async () => {
    await run(["init", "-q"]);
    await run(["add", "-A"]);
    await run(["-c", "user.name=althea", "-c", "user.email=althea@local", "commit", "-qm", "init"]);
  })();
}

/** Buat project kosong dari nama saja (folder + README stub + git init). */
export async function addBlank(
  s: AltheaState, name: string, goal = ""
): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" sudah ada` };
  mkdirSync(dir, { recursive: true });
  const g = goal.trim().slice(0, 500);
  writeFileSync(join(dir, "README.md"), `# ${name}\n\n${g ? `> ${g}\n\n` : ""}*Dibuat oleh Althea.*\n`);
  await ensureGitRepo(dir);
  return { ok: true, project: register(s, name, "blank") };
}

/** Buat project dari file PRD user (disimpan sebagai PRD.md). */
export async function addPrd(
  s: AltheaState, name: string, fileName: string, buf: Buffer
): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" sudah ada` };
  if (buf.includes(0)) return { ok: false, error: "bukan file teks" };
  const clean = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!clean) return { ok: false, error: "isi PRD kosong" };
  if (clean.length > 200_000) return { ok: false, error: "PRD melebihi 200 KB" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PRD.md"), clean.slice(0, 200_000));
  await ensureGitRepo(dir);
  return { ok: true, project: register(s, name, `prd:${fileName}`.slice(0, 120)) };
}

/** Hapus project (folder + registry). */
export function removeProject(s: AltheaState, name: string): { ok: boolean; error?: string } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  rmSync(dir, { recursive: true, force: true });
  s.projects = s.projects.filter((p) => p.name !== name);
  logEvent(s, `project -${name}`);
  return { ok: true };
}

const SKIP_DIRS = new Set([".git", "node_modules", ".svn", "__pycache__", "dist", "build", ".next", "coverage"]);

export interface FileEntry { path: string; size: number; }

/** Pohon file project (maksimal 200 entri; lewati folder berat). */
export function listFiles(name: string, max = 200): { ok: boolean; error?: string; files?: FileEntry[] } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  if (!existsSync(dir)) return { ok: false, error: "project tidak ada" };
  const out: FileEntry[] = [];
  const walk = (rel: string): void => {
    if (out.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(join(dir, rel));
    } catch { return; }
    for (const e of entries.sort()) {
      if (out.length >= max) return;
      const relPath = rel ? `${rel}/${e}` : e;
      let st;
      try {
        st = statSync(join(dir, relPath));
      } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e)) walk(relPath);
      } else if (st.isFile()) {
        out.push({ path: relPath, size: st.size });
      }
    }
  };
  walk("");
  return { ok: true, files: out };
}

/**
 * Pohon konteks hemat token (FR-3.8): maks 40 path, round-robin per direktori
 * teratas agar satu folder besar tak mendominasi, pangkas path > 4 segmen.
 */
export function contextTree(name: string, max = 40): string {
  const lf = listFiles(name, 200);
  if (!lf.ok || !lf.files?.length) return "-";
  const groups = new Map<string, string[]>();
  for (const f of lf.files) {
    const segs = f.path.split("/");
    if (segs.length > 4) continue;
    const top = segs.length > 1 ? segs[0] : "(root)";
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top)!.push(f.path);
  }
  const lists = [...groups.values()];
  const out: string[] = [];
  while (out.length < max && lists.some((l) => l.length)) {
    for (const l of lists) {
      if (out.length >= max) break;
      const p = l.shift();
      if (p) out.push(p);
    }
  }
  return out.length ? out.join("\n") : "-";
}

/** Foto file dir (rel → size+mtime), lewati folder berat, maks 500 entri. */
export function snapshotFiles(dir: string, max = 500): Map<string, { size: number; mtimeMs: number }> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  const walk = (rel: string): void => {
    if (out.size >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(join(dir, rel));
    } catch { return; }
    for (const e of entries.sort()) {
      if (out.size >= max) return;
      const relPath = rel ? `${rel}/${e}` : e;
      let st;
      try {
        st = statSync(join(dir, relPath));
      } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(e)) walk(relPath);
      } else if (st.isFile()) {
        out.set(relPath, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk("");
  return out;
}

export interface FileWatch {
  stop: () => void;
}

/**
 * Pantau dir selama run: laporkan file baru/berubah (sekali per path,
 * maks 50/run). Polling berantai agar tak tumpang-tindih di fs lambat.
 */
export function startFileWatch(
  dir: string,
  onChange: (kind: "file", text: string) => void,
  intervalMs = 3000,
): FileWatch {
  let before = snapshotFiles(dir);
  const emitted = new Set<string>();
  let count = 0;
  let dead = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    if (dead) return;
    try {
      const after = snapshotFiles(dir);
      for (const [rel, cur] of after) {
        if (count >= 50) break;
        const prev = before.get(rel);
        if (!prev && !emitted.has(`+${rel}`)) {
          emitted.add(`+${rel}`);
          count += 1;
          onChange("file", `baru: ${rel}`);
        } else if (prev && (prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size) && !emitted.has(`~${rel}`)) {
          emitted.add(`~${rel}`);
          count += 1;
          onChange("file", `ubah: ${rel}`);
        }
      }
      before = after;
    } catch { /* abaikan — watcher tak boleh menggagalkan run */ }
    if (!dead) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return { stop: () => { dead = true; if (timer) clearTimeout(timer); } };
}

/** Isi file teks project (maks 200 KB; tolak biner & traversal). */
export function readProjectFile(name: string, relPath: string): { ok: boolean; error?: string; content?: string } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  const target = resolve(join(dir, relPath));
  if (target !== dir && !target.startsWith(dir + sep)) return { ok: false, error: "path di luar project" };
  let st;
  try {
    st = statSync(target);
  } catch { return { ok: false, error: "file tidak ada" }; }
  if (!st.isFile() || st.size > 200 * 1024) return { ok: false, error: "bukan file teks ≤200 KB" };
  const buf = readFileSync(target);
  if (buf.includes(0)) return { ok: false, error: "file biner" };
  return { ok: true, content: buf.toString("utf8").slice(0, 200_000) };
}

/**
 * Isi STANDARDS.md project (FR-3.11; maks 4000 char) atau null bila tak ada.
 * Disuntik ke prompt tugas project oleh graph — satu sumber konvensi,
 * bukan instruksi berulang yang membakar token tiap tugas.
 */
export function readStandards(name: string, maxChars = 4000): string | null {
  const r = readProjectFile(name, "STANDARDS.md");
  if (!r.ok || !r.content) return null;
  const t = r.content.trim();
  return t ? t.slice(0, maxChars) : null;
}

/**
 * Potongan PRD.md project (FR-3.8; maks 1500 char) atau null bila tak ada.
 * Cukup untuk fokus kerja fase; model membaca file penuh hanya bila perlu.
 */
export function prdSlice(name: string, maxChars = 1500): string | null {
  const r = readProjectFile(name, "PRD.md");
  if (!r.ok || !r.content) return null;
  const t = r.content.trim();
  return t ? t.slice(0, maxChars) : null;
}

function git(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(config.gitBin, args, { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, out: String(stdout || stderr).slice(0, 100_000) });
    });
  });
}

/** Diff git project (stat + patch, maks 100 KB). Bukan repo → {repo:false}. */
export async function projectDiff(name: string): Promise<{ repo: boolean; stat?: string; diff?: string }> {
  const dir = projectDir(name);
  if (!dir || !existsSync(dir)) return { repo: false };
  const rev = await git(["rev-parse", "--git-dir"], dir);
  if (rev.code !== 0) return { repo: false };
  const [stat, diff, status] = await Promise.all([
    git(["diff", "--stat", "HEAD"], dir),
    git(["diff", "HEAD", "--no-color", "-U3"], dir),
    git(["status", "--short"], dir),
  ]);
  const untracked = status.out.split("\n").filter((l) => l.startsWith("??")).map((l) => `baru: ${l.slice(3)}`);
  const statText = [stat.out.trim(), ...untracked].filter(Boolean).join("\n") || "(bersih — tanpa perubahan)";
  return { repo: true, stat: statText, diff: diff.out };
}

/** Daftar project: registry + folder manual yang belum terdaftar. */
export function listProjects(s: AltheaState): Project[] {
  mkdirSync(config.workspaceDir, { recursive: true });
  const seen = new Set(s.projects.map((p) => p.name));
  const out = [...s.projects];
  for (const name of readdirSync(config.workspaceDir)) {
    if (seen.has(name) || !validName(name)) continue;
    const dir = join(config.workspaceDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch { continue; }
    out.push({ name, source: "manual", stack: detectStack(dir), addedAt: "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
