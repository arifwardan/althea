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

/**
 * Tech stack per lapisan. Default Althea = Laravel (BE) + Svelte (FE) +
 * PostgreSQL (DB) + Tailwind (CSS); kombinasi default disajikan via lerd.
 */
export interface StackSpec { fe: string; be: string; db: string; css: string; }

export const DEFAULT_STACK: StackSpec = { fe: "svelte", be: "laravel", db: "postgresql", css: "tailwind" };

export const STACK_OPTIONS: Record<keyof StackSpec, Array<{ id: string; label: string }>> = {
  fe: [
    { id: "svelte", label: "Svelte (default)" },
    { id: "react", label: "React" },
    { id: "vue", label: "Vue" },
    { id: "blade", label: "Blade only (no FE framework)" },
  ],
  be: [
    { id: "laravel", label: "Laravel (default — preview via lerd)" },
    { id: "node", label: "Node.js" },
    { id: "python", label: "Python" },
    { id: "go", label: "Go" },
  ],
  db: [
    { id: "postgresql", label: "PostgreSQL (default)" },
    { id: "mysql", label: "MySQL" },
    { id: "sqlite", label: "SQLite" },
    { id: "none", label: "No database" },
  ],
  css: [
    { id: "tailwind", label: "Tailwind (default)" },
    { id: "tailwind-shadcn", label: "Tailwind + shadcn/ui" },
    { id: "bootstrap", label: "Bootstrap" },
    { id: "plain", label: "Plain CSS" },
  ],
};

const STACK_IDS: Record<keyof StackSpec, string[]> = {
  fe: STACK_OPTIONS.fe.map((o) => o.id),
  be: STACK_OPTIONS.be.map((o) => o.id),
  db: STACK_OPTIONS.db.map((o) => o.id),
  css: STACK_OPTIONS.css.map((o) => o.id),
};

/** Petakan string stack lama ("laravel"|"node"|...) ke spec per lapisan. */
function legacyStackString(t: string): StackSpec {
  if (t === "node") return { ...DEFAULT_STACK, be: "node" };
  if (t === "python") return { ...DEFAULT_STACK, be: "python" };
  if (t === "go") return { ...DEFAULT_STACK, be: "go" };
  return { ...DEFAULT_STACK };
}

/** Normalisasi pilihan stack user (objek parsial / string lama / kosong → default per lapisan). */
export function normalizeStackSpec(v: unknown): StackSpec {
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (!t) return { ...DEFAULT_STACK };
    if (["laravel", "node", "python", "go", "generic"].includes(t)) return legacyStackString(t);
    return { ...DEFAULT_STACK };
  }
  const o = (v && typeof v === "object" ? v : {}) as Partial<StackSpec>;
  const pick = (k: keyof StackSpec): string => {
    const t = String(o[k] || "").trim().toLowerCase();
    return STACK_IDS[k].includes(t) ? t : DEFAULT_STACK[k];
  };
  return { fe: pick("fe"), be: pick("be"), db: pick("db"), css: pick("css") };
}

/** Kombinasi default penuh (keempat lapisan). */
export function isDefaultStack(v: unknown): boolean {
  const s = normalizeStackSpec(v);
  return s.fe === DEFAULT_STACK.fe && s.be === DEFAULT_STACK.be &&
    s.db === DEFAULT_STACK.db && s.css === DEFAULT_STACK.css;
}

/** Preview (lerd) hanya untuk BE Laravel. Kosong = project lama → dianggap default. */
export function isPreviewStack(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string" && !v.trim()) return true;
  return normalizeStackSpec(v).be === "laravel";
}

const STACK_LABEL: Record<string, string> = {
  svelte: "Svelte", react: "React", vue: "Vue", blade: "Blade",
  laravel: "Laravel", node: "Node.js", python: "Python", go: "Go",
  postgresql: "PostgreSQL", mysql: "MySQL", sqlite: "SQLite", none: "no DB",
  tailwind: "Tailwind", "tailwind-shadcn": "Tailwind+shadcn/ui", bootstrap: "Bootstrap", plain: "Plain CSS",
};

/** Ringkasan satu baris: "Laravel + Svelte + PostgreSQL + Tailwind". */
export function stackSummary(v: unknown): string {
  const s = normalizeStackSpec(v);
  const lbl = (id: string): string => STACK_LABEL[id] || id;
  return `${lbl(s.be)} + ${lbl(s.fe)} + ${lbl(s.db)} + ${lbl(s.css)}`;
}

// ---------------------------------------------------------------------------
// Kategori aplikasi berlapis (fungsi, model bisnis, arsitektur, target, interaksi).
// Satu aplikasi bisa memegang beberapa nilai per dimensi,
// mis. E-commerce (fungsi) + B2C (bisnis) + SPA (arsitektur) + Public (target) + Transaksional (interaksi).
// ---------------------------------------------------------------------------

export const CATEGORY_DIMS = ["fungsi", "bisnis", "arsitektur", "target", "interaksi"] as const;
export type CategoryDim = (typeof CATEGORY_DIMS)[number];
export type CategorySet = Record<CategoryDim, string[]>;

export const CATEGORY_TAXONOMY: Record<CategoryDim, Array<{ id: string; label: string }>> = {
  fungsi: [
    { id: "e-commerce", label: "E-commerce & Marketplace" },
    { id: "saas-bisnis", label: "SaaS & Tools Bisnis" },
    { id: "cms-blog", label: "CMS & Blog" },
    { id: "sosial-komunitas", label: "Sosial & Komunitas" },
    { id: "produktivitas", label: "Produktivitas & Kolaborasi" },
    { id: "edukasi", label: "Pendidikan & E-Learning" },
    { id: "fintech", label: "Keuangan & Fintech" },
    { id: "kesehatan", label: "Kesehatan & Fitness" },
    { id: "travel", label: "Travel & Booking" },
    { id: "hiburan-media", label: "Hiburan & Media" },
    { id: "berita-portal", label: "Berita & Portal Informasi" },
    { id: "pencarian-direktori", label: "Pencarian & Direktori" },
    { id: "ai-ml", label: "AI & Machine Learning" },
    { id: "dev-tools", label: "Developer Tools & API" },
    { id: "admin-internal", label: "Dashboard Admin & Internal Tools" },
    { id: "pemerintahan", label: "Pemerintahan & Layanan Publik" },
    { id: "manajemen-proyek", label: "Manajemen Proyek & Task" },
    { id: "crm-erp", label: "CRM & ERP" },
    { id: "analitik-bi", label: "Analitik & Business Intelligence" },
    { id: "portofolio", label: "Portofolio & Personal Branding" },
    { id: "properti", label: "Properti & Kost" },
    { id: "kuliner", label: "Kuliner & Resto" },
  ],
  bisnis: [
    { id: "b2b", label: "B2B" },
    { id: "b2c", label: "B2C" },
    { id: "c2c", label: "C2C" },
    { id: "b2b2c", label: "B2B2C" },
    { id: "saas", label: "SaaS (langganan)" },
    { id: "marketplace", label: "Marketplace" },
    { id: "freemium", label: "Freemium" },
    { id: "iklan", label: "Iklan" },
    { id: "on-demand", label: "On-demand" },
  ],
  arsitektur: [
    { id: "static", label: "Static Site" },
    { id: "ssr", label: "Server-Side Rendering (SSR)" },
    { id: "spa", label: "Single Page Application (SPA)" },
    { id: "pwa", label: "Progressive Web App (PWA)" },
    { id: "api-first", label: "API-first" },
    { id: "microservices", label: "Microservices" },
    { id: "monolith", label: "Monolith" },
    { id: "serverless", label: "Serverless" },
  ],
  target: [
    { id: "public", label: "Public" },
    { id: "internal", label: "Internal" },
    { id: "partner", label: "Partner" },
    { id: "admin", label: "Admin" },
    { id: "customer", label: "Customer" },
  ],
  interaksi: [
    { id: "crud", label: "CRUD" },
    { id: "real-time", label: "Real-time" },
    { id: "streaming", label: "Streaming" },
    { id: "transaksional", label: "Transaksional" },
    { id: "analitik", label: "Analitik" },
    { id: "otomasi", label: "Otomasi" },
  ],
};

export const CATEGORY_DIM_LABEL: Record<CategoryDim, string> = {
  fungsi: "Function",
  bisnis: "Business model",
  arsitektur: "Arsitektur",
  target: "Target users",
  interaksi: "Interaction",
};

export function emptyCategories(): CategorySet {
  return { fungsi: [], bisnis: [], arsitektur: [], target: [], interaksi: [] };
}

const MAX_CAT_PER_DIM = 6;

/** Normalisasi set kategori: rapikan string, buang kosong/duplikat, batasi per dimensi. */
export function normalizeCategories(v: unknown): CategorySet {
  const out = emptyCategories();
  if (!v || typeof v !== "object") return out;
  const o = v as Partial<Record<CategoryDim, unknown>>;
  for (const dim of CATEGORY_DIMS) {
    const raw = o[dim];
    const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const seen = new Set<string>();
    for (const item of arr) {
      const t = String(item || "").trim().toLowerCase().slice(0, 40);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out[dim].push(t);
      if (out[dim].length >= MAX_CAT_PER_DIM) break;
    }
  }
  return out;
}

/** Apakah set kategori kosong di semua dimensi. */
export function categoriesEmpty(c: CategorySet): boolean {
  return CATEGORY_DIMS.every((d) => c[d].length === 0);
}

const FUNGSI_RULES: Array<[RegExp, string]> = [
  [/\b(checkout|keranjang|katalog|marketplace|olshop|jualan|toko online|toko)\b/i, "e-commerce"],
  [/\b(blog|wordpress|cms|ghost|medium)\b/i, "cms-blog"],
  [/\b(komunitas|forum|feed|pengikut|like|komentar)\b/i, "sosial-komunitas"],
  [/\b(kolaborasi|dokumen bersama|catatan|wiki|notion|kanban pribadi)\b/i, "produktivitas"],
  [/\b(sekolah|siswa|guru|kampus|mahasiswa|kursus|pelajaran|belajar|ujian|e-learning|ruangguru)\b/i, "edukasi"],
  [/\b(pembayaran|dompet|transfer|bank|investasi|asuransi|keuangan|gaji|payroll|invoice|gopay|ovo|stripe)\b/i, "fintech"],
  [/\b(dokter|pasien|klinik|rumah sakit|obat|apotek|kesehatan|fitness|halodoc|strava)\b/i, "kesehatan"],
  [/\b(tiket|hotel|wisata|travel|penerbangan|traveloka|airbnb)\b/i, "travel"],
  [/\b(musik|video|film|podcast|streaming|spotify|netflix|youtube|hiburan)\b/i, "hiburan-media"],
  [/\b(berita|koran|headline|detik|cnn|kompas|portal berita)\b/i, "berita-portal"],
  [/\b(pencarian|direktori|yellow pages|yelp|listing usaha)\b/i, "pencarian-direktori"],
  [/\b(chatbot|\bai\b|kecerdasan buatan|machine learning|generatif|midjourney|rekomendasi cerdas)\b/i, "ai-ml"],
  [/\b(\bapi\b|sdk|webhook|postman|dokumentasi api|github)\b/i, "dev-tools"],
  [/\b(dashboard admin|admin panel|hris|absensi|karyawan|staf|internal perusahaan)\b/i, "admin-internal"],
  [/\b(pajak|e-ktp|pemerintah|desa|kelurahan|surat keterangan|layanan publik|sirup)\b/i, "pemerintahan"],
  [/\b(sprint|jira|deadline|tugas proyek|clickup|linear)\b/i, "manajemen-proyek"],
  [/\b(\bcrm\b|\berp\b|sales|lead|odoo|salesforce|sap|inventori|gudang|supplier)\b/i, "crm-erp"],
  [/\b(grafik|statistik|analitik|business intelligence|tableau|metabase|looker)\b/i, "analitik-bi"],
  [/\b(portofolio|\bcv\b|personal branding|profil pribadi|behance|linkedin)\b/i, "portofolio"],
  [/\b(kost|kontrakan|apartemen|properti|sewa (kamar|rumah)|penghuni|simakost)\b/i, "properti"],
  [/\b(restoran|resto|kafe|cafe|kuliner|resep|order meja)\b/i, "kuliner"],
  [/\b(kasir|\bpos\b|warung|toko kelontong)\b/i, "e-commerce"],
];

const BISNIS_RULES: Array<[RegExp, string]> = [
  [/\b(langganan|subscription|berbayar bulanan|paket premium|berbayar per (bulan|tahun))\b/i, "saas"],
  [/\b(penjual.*pembeli|multi.?vendor|dua sisi|pasar online)\b/i, "marketplace"],
  [/\b(dropship|reseller|shopify)\b/i, "b2b2c"],
  [/\b(gratis.*premium|freemium|batas gratis|upgrade premium)\b/i, "freemium"],
  [/\b(iklan|adsense|monetisasi iklan|pendapatan iklan)\b/i, "iklan"],
  [/\b(antar jemput|ojek|on.?demand|sesuai permintaan|pesan antar|gojek|uber)\b/i, "on-demand"],
  [/\b(antar pengguna|barang bekas|preloved|jual beli antar|olx)\b/i, "c2c"],
  [/\b(perusahaan|korporat|klien bisnis|untuk (perusahaan|bisnis|kantor))\b/i, "b2b"],
];

const ARSITEKTUR_RULES: Array<[RegExp, string]> = [
  [/\b(statis|landing page|jekyll|hugo|html saja)\b/i, "static"],
  [/\b(react|vue|svelte|\bspa\b|tanpa reload|gmail)\b/i, "spa"],
  [/\b(\bpwa\b|bisa diinstal|offline|twitter lite)\b/i, "pwa"],
  [/\b(flutter|react native|\bapi\b.*terpisah|mobile.*api|api-first)\b/i, "api-first"],
  [/\b(microservice|layanan kecil|layanan terpisah)\b/i, "microservices"],
  [/\b(lambda|serverless|vercel function|cloud function|edge function)\b/i, "serverless"],
];

const TARGET_RULES: Array<[RegExp, string]> = [
  [/\b(karyawan|staf|hris|internal|khusus (karyawan|staf))\b/i, "internal"],
  [/\b(mitra|supplier|reseller|vendor|portal supplier)\b/i, "partner"],
  [/\b(pengelola|operator|petugas)\b/i, "admin"],
  [/\b(nasabah|pelanggan|warga|siswa|pasien|penghuni|penyewa|pembeli)\b/i, "customer"],
];

const INTERAKSI_RULES: Array<[RegExp, string]> = [
  [/\b(\bcrud\b|\bkelola\b|tambah.*ubah.*hapus|formulir|pendataan)\b/i, "crud"],
  [/\b(chat|realtime|real.?time|websocket|notifikasi langsung|live)\b/i, "real-time"],
  [/\b(streaming|video|audio|musik|film)\b/i, "streaming"],
  [/\b(bayar|checkout|transaksi|pembayaran|booking|pesanan|tagihan|kasir)\b/i, "transaksional"],
  [/\b(laporan|grafik|ringkasan|statistik|dashboard)\b/i, "analitik"],
  [/\b(otomatis|workflow|terjadwal|pengingat|sinkronisasi|zapier)\b/i, "otomasi"],
];

function matchRules(text: string, rules: Array<[RegExp, string]>, cap = 4): string[] {
  const out: string[] = [];
  for (const [re, id] of rules) {
    if (re.test(text) && !out.includes(id)) {
      out.push(id);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/**
 * Tebak kategori berlapis dari teks PRD/goal (deterministik, 0 token LLM).
 * Dipakai saat user mengosongkan kategori — aturan kata kunci per dimensi.
 */
export function inferCategories(text: unknown, stack?: StackSpec): CategorySet {
  const t = String(text || "");
  const c = emptyCategories();
  if (!t.trim()) return c;
  c.fungsi = matchRules(t, FUNGSI_RULES);
  if (!c.fungsi.length && t.trim()) c.fungsi = ["umum"];
  c.bisnis = matchRules(t, BISNIS_RULES, 3);
  c.target = matchRules(t, TARGET_RULES, 2);
  if (!c.target.length && t.trim()) c.target = ["public"];
  c.interaksi = matchRules(t, INTERAKSI_RULES);
  const arch = matchRules(t, ARSITEKTUR_RULES, 3);
  if (!arch.length) {
    arch.push("monolith");
    if ((!stack || stack.be === "laravel") && t.trim()) arch.unshift("ssr");
  }
  c.arsitektur = arch;
  return c;
}

/**
 * Kategori final: dimensi yang user isi menang, dimensi kosong ditebak dari teks.
 * Tanpa teks sumber → dimensi kosong tetap kosong (kecuali pilihan user).
 */
export function autoCategories(userCats: unknown, text: unknown, stack?: StackSpec): CategorySet {
  const user = normalizeCategories(userCats);
  const src = String(text || "").trim();
  if (!src) return user;
  const guessed = inferCategories(src, stack);
  const out = emptyCategories();
  for (const dim of CATEGORY_DIMS) {
    out[dim] = user[dim].length ? user[dim] : guessed[dim];
  }
  return out;
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

export interface ProjectOpts { stack?: unknown; techStack?: unknown; categories?: unknown; category?: unknown; }

/** Set kategori dari opts: objek berlapis menang, string lama → dimensi fungsi. */
function optsCategories(opts: ProjectOpts, prev: Project | null): CategorySet {
  const fromOpts = normalizeCategories(
    opts.categories ?? (opts.category !== undefined ? { fungsi: [opts.category] } : undefined),
  );
  if (!categoriesEmpty(fromOpts)) return fromOpts;
  if (prev?.categories && !categoriesEmpty(normalizeCategories(prev.categories))) {
    return normalizeCategories(prev.categories);
  }
  const legacy = String((prev as { category?: unknown } | null)?.category || "").trim();
  if (legacy) return normalizeCategories({ fungsi: [legacy] });
  return emptyCategories();
}

function register(s: AltheaState, name: string, source: string, opts: ProjectOpts = {}): Project {
  mkdirSync(config.workspaceDir, { recursive: true });
  const dir = projectDir(name) as string;
  const stack = detectStack(dir);
  const now = new Date().toISOString();
  const prev = s.projects.findIndex((p) => p.name === name);
  const prevProj = prev >= 0 ? s.projects[prev] : null;
  const proj: Project = {
    name, source, stack, addedAt: prevProj ? prevProj.addedAt : now,
    stackSpec: normalizeStackSpec(
      opts.stack ?? opts.techStack ?? prevProj?.stackSpec ?? (prevProj as { techStack?: unknown } | null)?.techStack,
    ),
    categories: optsCategories(opts, prevProj),
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
export function addFromRepo(s: AltheaState, name: string, repoUrl: string, opts: ProjectOpts = {}): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return Promise.resolve({ ok: false, error: "invalid project name" });
  if (!validRepoUrl(repoUrl)) return Promise.resolve({ ok: false, error: "invalid repo URL (https://… or git@host:path.git)" });
  if (existsSync(dir)) return Promise.resolve({ ok: false, error: `folder "${name}" already exists` });
  mkdirSync(config.workspaceDir, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(config.gitBin, ["clone", "--depth", "1", repoUrl.trim(), dir], {
      timeout: config.gitTimeoutSeconds * 1000,
      shell: false,
    });
    let err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => resolve({ ok: false, error: `git failed to run: ${String(e).slice(0, 200)}` }));
    child.on("close", (code) => {
      if (code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        resolve({ ok: false, error: `git clone failed (exit ${code}): ${err.slice(0, 300)}` });
        return;
      }
      resolve({ ok: true, project: register(s, name, repoUrl.trim(), opts) });
    });
  });
}

/** Ekstrak buffer zip ke workspace/<name>. */
export function addFromZip(
  s: AltheaState, name: string, fileName: string, buf: Buffer, opts: ProjectOpts = {}
): { ok: boolean; error?: string; project?: Project } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "invalid project name" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" already exists` };
  if (buf.length > config.projectMaxMb * 1024 * 1024) {
    return { ok: false, error: `zip exceeds the ${config.projectMaxMb} MB` };
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch {
    return { ok: false, error: "not a valid zip file" };
  }
  const entries = safeZipEntries(zip);
  if (entries.length === 0) return { ok: false, error: "zip is empty / all entries rejected" };
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
    return { ok: false, error: `zip extraction failed: ${String(e).slice(0, 200)}` };
  }
  return { ok: true, project: register(s, name, `zip:${fileName}`.slice(0, 120), opts) };
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
  s: AltheaState, name: string, goal = "", opts: ProjectOpts = {}
): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "invalid project name" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" already exists` };
  mkdirSync(dir, { recursive: true });
  const g = goal.trim().slice(0, 500);
  writeFileSync(join(dir, "README.md"), `# ${name}\n\n${g ? `> ${g}\n\n` : ""}*Dibuat oleh Althea.*\n`);
  await ensureGitRepo(dir);
  const spec = normalizeStackSpec(opts.stack ?? opts.techStack);
  const cats = autoCategories(opts.categories ?? opts.category, g, spec);
  return { ok: true, project: register(s, name, "blank", { stack: spec, categories: cats }) };
}

/** Buat project dari file PRD user (disimpan sebagai PRD.md). */
export async function addPrd(
  s: AltheaState, name: string, fileName: string, buf: Buffer, opts: ProjectOpts = {}
): Promise<{ ok: boolean; error?: string; project?: Project }> {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "invalid project name" };
  if (existsSync(dir)) return { ok: false, error: `folder "${name}" already exists` };
  if (buf.includes(0)) return { ok: false, error: "not a text file" };
  const clean = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!clean) return { ok: false, error: "PRD is empty" };
  if (clean.length > 200_000) return { ok: false, error: "PRD exceeds 200 KB" };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PRD.md"), clean.slice(0, 200_000));
  await ensureGitRepo(dir);
  const spec = normalizeStackSpec(opts.stack ?? opts.techStack);
  const cats = autoCategories(opts.categories ?? opts.category, clean, spec);
  return { ok: true, project: register(s, name, `prd:${fileName}`.slice(0, 120), { stack: spec, categories: cats }) };
}

/** Hapus project (folder + registry). */
export function removeProject(s: AltheaState, name: string): { ok: boolean; error?: string } {
  const dir = projectDir(name);
  if (!dir) return { ok: false, error: "invalid project name" };
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
  if (!dir) return { ok: false, error: "invalid project name" };
  if (!existsSync(dir)) return { ok: false, error: "project does not exist" };
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
          onChange("file", `new: ${rel}`);
        } else if (prev && (prev.mtimeMs !== cur.mtimeMs || prev.size !== cur.size) && !emitted.has(`~${rel}`)) {
          emitted.add(`~${rel}`);
          count += 1;
          onChange("file", `modified: ${rel}`);
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
  if (!dir) return { ok: false, error: "invalid project name" };
  const target = resolve(join(dir, relPath));
  if (target !== dir && !target.startsWith(dir + sep)) return { ok: false, error: "path is outside the project" };
  let st;
  try {
    st = statSync(target);
  } catch { return { ok: false, error: "file does not exist" }; }
  if (!st.isFile() || st.size > 200 * 1024) return { ok: false, error: "not a text file ≤200 KB" };
  const buf = readFileSync(target);
  if (buf.includes(0)) return { ok: false, error: "binary file" };
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
  const untracked = status.out.split("\n").filter((l) => l.startsWith("??")).map((l) => `new: ${l.slice(3)}`);
  const statText = [stat.out.trim(), ...untracked].filter(Boolean).join("\n") || "(clean — no changes)";
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
