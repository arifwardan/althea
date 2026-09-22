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
  const proj: Project = { name, source, stack, addedAt: prev >= 0 ? s.projects[prev].addedAt : now };
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

/** Hapus project (folder + registry). */
export function removeProject(s: AltheaState, name: string): { ok: boolean; error?: string } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "nama project tidak valid" };
  rmSync(dir, { recursive: true, force: true });
  s.projects = s.projects.filter((p) => p.name !== name);
  logEvent(s, `project -${name}`);
  return { ok: true };
}

const SKIP_DIRS = new Set([".git", "node_modules", ".svn", "__pycache__", "dist", "build"]);

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
