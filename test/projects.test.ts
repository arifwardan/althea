// Workspace projects: validasi, zip aman, registry, multipart.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { config } from "../src/config.js";
import { defaultState } from "../src/state.js";
import {
  validName, validRepoUrl, projectDir, detectStack, safeZipEntries,
  addFromZip, addFromRepo, removeProject, listProjects,
  listFiles, readProjectFile, projectDiff, snapshotFiles, startFileWatch,
  readStandards, prdSlice, contextTree, addBlank, addPrd,
  normalizeStackSpec, isDefaultStack, isPreviewStack, stackSummary,
  normalizeCategories, inferCategories, autoCategories, categoriesEmpty,
} from "../src/projects.js";
import { parseMultipart } from "../src/server.js";

let tmp = "";
let prevWs = "";

beforeEach(() => {
  prevWs = config.workspaceDir;
  tmp = mkdtempSync(join(tmpdir(), "althea-ws-"));
  config.workspaceDir = tmp;
});
afterEach(() => {
  config.workspaceDir = prevWs;
  rmSync(tmp, { recursive: true, force: true });
});

describe("validasi", () => {
  it("nama project ketat", () => {
    assert.equal(validName("toko-online_2.0"), true);
    for (const bad of ["../x", "a/b", "", ".", "..", "a b", "a;b", "x".repeat(70)]) {
      assert.equal(validName(bad), false, bad);
    }
  });
  it("URL repo https / scp saja", () => {
    assert.equal(validRepoUrl("https://github.com/a/b.git"), true);
    assert.equal(validRepoUrl("git@github.com:a/b.git"), true);
    assert.equal(validRepoUrl("file:///etc/passwd"), false);
    assert.equal(validRepoUrl("https://"), false);
    assert.equal(validRepoUrl("rm -rf /"), false);
  });
  it("projectDir tak bisa keluar workspace", () => {
    assert.ok((projectDir("ok") as string).startsWith(tmp));
    assert.equal(projectDir("../kabur"), null);
  });
  it("detectStack dari penanda", () => {
    const d = join(tmp, "p");
    mkdirSync(d);
    assert.equal(detectStack(d), "generic");
    writeFileSync(join(d, "go.mod"), "module x");
    assert.equal(detectStack(d), "go");
  });
});

describe("zip aman", () => {
  it("safeZipEntries membuang zip-slip", () => {
    const zip = new AdmZip();
    zip.addFile("a.txt", Buffer.from("ok"));
    zip.addFile("sub/b.txt", Buffer.from("ok"));
    zip.addFile("../evil.txt", Buffer.from("x"));
    zip.addFile("/abs.txt", Buffer.from("x"));
    const names = safeZipEntries(zip);
    assert.ok(names.includes("a.txt") && names.includes("sub/b.txt"));
    assert.ok(!names.some((n) => n.includes("..") || n.startsWith("/")));
  });
  it("addFromZip ekstrak + rapikan bungkus root tunggal", () => {
    const zip = new AdmZip();
    zip.addFile("repo-main/package.json", Buffer.from("{}"));
    zip.addFile("repo-main/src/i.js", Buffer.from("1"));
    const s = defaultState();
    const r = addFromZip(s, "demo", "demo.zip", zip.toBuffer());
    assert.equal(r.ok, true);
    assert.equal(r.project?.stack, "node");
    assert.ok(s.projects.some((p) => p.name === "demo"));
  });
  it("addFromZip menolak nama jelek, duplikat, dan bukan-zip", () => {
    const s = defaultState();
    assert.equal(addFromZip(s, "../x", "a.zip", Buffer.from("PK")).ok, false);
    assert.equal(addFromZip(s, "n", "a.zip", Buffer.from("bukan zip")).ok, false);
    const zip = new AdmZip();
    zip.addFile("f.txt", Buffer.from("1"));
    assert.equal(addFromZip(s, "dup", "a.zip", zip.toBuffer()).ok, true);
    assert.match(addFromZip(s, "dup", "a.zip", zip.toBuffer()).error as string, /already exists/);
  });
});

describe("tech stack per lapisan", () => {
  it("normalizeStackSpec: kosong → default penuh", () => {
    assert.deepEqual(normalizeStackSpec(undefined), { fe: "svelte", be: "laravel", db: "postgresql", css: "tailwind" });
    assert.deepEqual(normalizeStackSpec(""), { fe: "svelte", be: "laravel", db: "postgresql", css: "tailwind" });
  });
  it("normalizeStackSpec: parsial + string lama", () => {
    assert.deepEqual(normalizeStackSpec({ be: "node" }), { fe: "svelte", be: "node", db: "postgresql", css: "tailwind" });
    assert.deepEqual(normalizeStackSpec("node"), { fe: "svelte", be: "node", db: "postgresql", css: "tailwind" });
    assert.deepEqual(normalizeStackSpec({ be: "rails", db: "mysql" }), { fe: "svelte", be: "laravel", db: "mysql", css: "tailwind" });
  });
  it("isDefaultStack / isPreviewStack / stackSummary", () => {
    assert.equal(isDefaultStack(undefined), true);
    assert.equal(isDefaultStack({ be: "node" }), false);
    assert.equal(isPreviewStack("laravel"), true);
    assert.equal(isPreviewStack(""), true); // project lama tanpa pilihan
    assert.equal(isPreviewStack(undefined), true);
    assert.equal(isPreviewStack({ be: "laravel", fe: "react" }), true); // BE Laravel tetap preview
    assert.equal(isPreviewStack("node"), false);
    assert.equal(isPreviewStack({ be: "go" }), false);
    assert.equal(stackSummary(undefined), "Laravel + Svelte + PostgreSQL + Tailwind");
  });
});

describe("kategori berlapis", () => {
  it("normalizeCategories: rapikan + batasi", () => {
    const c = normalizeCategories({ fungsi: [" E-Commerce ", "e-commerce", ""], bisnis: "b2c", aneh: ["x"] });
    assert.deepEqual(c.fungsi, ["e-commerce"]);
    assert.deepEqual(c.bisnis, ["b2c"]);
    assert.deepEqual(c.interaksi, []);
  });
  it("inferCategories menebak berlapis ala SIMAKOST", () => {
    const c = inferCategories("sistem informasi kost: kelola kamar, data penghuni, pembayaran bulanan, laporan");
    assert.ok(c.fungsi.includes("properti"), JSON.stringify(c));
    assert.ok(c.interaksi.includes("crud"), JSON.stringify(c));
    assert.ok(c.interaksi.includes("transaksional"), JSON.stringify(c));
    assert.ok(c.arsitektur.includes("monolith"), JSON.stringify(c));
    assert.ok(c.target.includes("customer"), JSON.stringify(c));
  });
  it("inferCategories: kasir + teks kosong", () => {
    const c = inferCategories("aplikasi pos kasir warung dengan checkout");
    assert.ok(c.fungsi.includes("e-commerce"), JSON.stringify(c));
    assert.ok(c.interaksi.includes("transaksional"), JSON.stringify(c));
    assert.ok(categoriesEmpty(inferCategories("")));
    assert.deepEqual(inferCategories("halo dunia").fungsi, ["umum"]);
  });
  it("autoCategories: dimensi user menang, kosong ditebak", () => {
    const c = autoCategories({ fungsi: ["edukasi"] }, "aplikasi pos kasir warung");
    assert.deepEqual(c.fungsi, ["edukasi"]);
    assert.ok(c.interaksi.includes("transaksional"), JSON.stringify(c));
    assert.ok(categoriesEmpty(autoCategories(undefined, "   ")));
  });
  it("addBlank: default stack + kategori dari goal bila tak diisi", async () => {
    const s = defaultState();
    const r = await addBlank(s, "kasirku", "aplikasi pos kasir warung");
    assert.equal(r.ok, true);
    assert.equal(isDefaultStack(r.project?.stackSpec), true);
    assert.ok(r.project?.categories?.fungsi.includes("e-commerce"), JSON.stringify(r.project?.categories));
  });
  it("addBlank: spec non-default tersimpan; kategori user dihormati", async () => {
    const s = defaultState();
    const r = await addBlank(s, "pyku", "skrip otomasi", {
      stack: { be: "python", db: "sqlite" },
      categories: { interaksi: ["otomasi"] },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.project?.stackSpec, { fe: "svelte", be: "python", db: "sqlite", css: "tailwind" });
    assert.deepEqual(r.project?.categories?.interaksi, ["otomasi"]);
    assert.equal(isPreviewStack(r.project?.stackSpec), false);
  });
  it("addPrd: kategori ditebak dari isi PRD bila kosong", async () => {
    const s = defaultState();
    const r = await addPrd(s, "klinikku", "r.md", Buffer.from("# PRD\nsistem informasi klinik: dokter, pasien, antrian"));
    assert.equal(r.ok, true);
    assert.ok(r.project?.categories?.fungsi.includes("kesehatan"), JSON.stringify(r.project?.categories));
    assert.equal(isDefaultStack(r.project?.stackSpec), true);
  });
});

describe("registry", () => {
  it("removeProject + listProjects (termasuk folder manual)", async () => {
    const s = defaultState();
    const bad = await addFromRepo(s, "x", "bukan-url");
    assert.equal(bad.ok, false);
    mkdirSync(join(tmp, "manual"));
    assert.equal(listProjects(s).length, 1);
    assert.equal(listProjects(s)[0].source, "manual");
    const zip = new AdmZip();
    zip.addFile("f.txt", Buffer.from("1"));
    addFromZip(s, "zz", "a.zip", zip.toBuffer());
    assert.equal(listProjects(s).length, 2);
    assert.equal(removeProject(s, "zz").ok, true);
    assert.equal(listProjects(s).length, 1);
  });
});

describe("review: files + isi file", () => {
  it("listFiles lewati folder berat; readProjectFile aman", () => {
    const s = defaultState();
    const zip = new AdmZip();
    zip.addFile("a.js", Buffer.from("console.log(1)"));
    zip.addFile("node_modules/x.js", Buffer.from("skip"));
    addFromZip(s, "rv", "a.zip", zip.toBuffer());
    const lf = listFiles("rv");
    assert.equal(lf.ok, true);
    assert.deepEqual(lf.files?.map((f) => f.path), ["a.js"]);
    assert.equal(readProjectFile("rv", "a.js").content, "console.log(1)");
    assert.equal(readProjectFile("rv", "../kabur").ok, false);
    assert.equal(readProjectFile("rv", "tak-ada.js").ok, false);
  });
});

describe("context pack (FR-3.8, FR-3.11)", () => {
  it("readStandards/prdSlice: ada → isi terpangkas; tak ada → null", () => {
    const d = join(tmp, "ctx");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "STANDARDS.md"), "aturan main");
    writeFileSync(join(d, "PRD.md"), "X".repeat(5000));
    assert.equal(readStandards("ctx"), "aturan main");
    assert.equal(prdSlice("ctx")?.length, 1500);
    assert.equal(readStandards("tak-ada"), null);
    assert.equal(prdSlice("tak-ada"), null);
  });
  it("contextTree: round-robin, pangkas dalam, lewati folder berat", () => {
    const d = join(tmp, "ctx2");
    mkdirSync(join(d, "a"), { recursive: true });
    mkdirSync(join(d, "b"), { recursive: true });
    mkdirSync(join(d, "node_modules"), { recursive: true });
    mkdirSync(join(d, "a", "deep", "deeper", "too", "deep"), { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(d, "a", `f${i}.ts`), "x");
    writeFileSync(join(d, "b", "g.ts"), "y");
    writeFileSync(join(d, "node_modules", "z.js"), "skip");
    writeFileSync(join(d, "a", "deep", "deeper", "too", "deep", "h.ts"), "deep");
    const lines = contextTree("ctx2", 6).split("\n");
    assert.equal(lines.length, 6);
    assert.ok(lines.includes("b/g.ts")); // folder kecil tak tergusur folder besar
    assert.ok(!lines.some((l) => l.startsWith("node_modules")));
    assert.ok(!lines.some((l) => l.includes("too/deep")));
  });
});

describe("review: projectDiff", () => {
  it("repo git → stat+diff; bukan repo → repo:false", async (t) => {
    const { execSync } = await import("node:child_process");
    try {
      execSync("git --version", { stdio: "ignore" });
    } catch {
      t.skip("git tidak tersedia");
      return;
    }
    mkdirSync(join(tmp, "gr"), { recursive: true });
    const g = (a: string) => execSync(`git ${a}`, { cwd: join(tmp, "gr"), stdio: "ignore" });
    g("init -q");
    g("-c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
    writeFileSync(join(tmp, "gr", "f.txt"), "baru");
    const d = await projectDiff("gr");
    assert.equal(d.repo, true);
    assert.match(d.stat as string, /new: f.txt/);
    mkdirSync(join(tmp, "ng"));
    assert.equal((await projectDiff("ng")).repo, false);
  });
});

describe("parseMultipart", () => {
  it("baca field + file biner utuh", () => {
    const bdy = "----batas7";
    const raw = Buffer.concat([
      Buffer.from(`------batas7\r\nContent-Disposition: form-data; name="name"\r\n\r\ndemo\r\n`),
      Buffer.from(`------batas7\r\nContent-Disposition: form-data; name="file"; filename="a.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x41]),
      Buffer.from(`\r\n------batas7--\r\n`),
    ]);
    const { fields, files } = parseMultipart(raw, `multipart/form-data; boundary=----batas7`);
    assert.equal(fields.name, "demo");
    assert.equal(files.length, 1);
    assert.deepEqual(files[0].data, Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x41]));
  });
});

describe("file watcher", () => {
  it("snapshot lewati folder berat (.next, node_modules)", () => {
    mkdirSync(join(tmp, "w", ".next"), { recursive: true });
    mkdirSync(join(tmp, "w", "node_modules"), { recursive: true });
    writeFileSync(join(tmp, "w", ".next", "x.js"), "1");
    writeFileSync(join(tmp, "w", "a.txt"), "1");
    const snap = snapshotFiles(join(tmp, "w"));
    assert.ok(snap.has("a.txt"));
    assert.ok(![...snap.keys()].some((k) => k.includes(".next") || k.includes("node_modules")));
  });
  it("startFileWatch laporkan baru/ubah sekali per path", async () => {
    const dir = join(tmp, "ww");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ada.txt"), "1");
    const got: string[] = [];
    const w = startFileWatch(dir, (_k, t) => got.push(t), 20);
    try {
      writeFileSync(join(dir, "baru.txt"), "2");
      writeFileSync(join(dir, "ada.txt"), "222");
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      w.stop();
    }
    assert.ok(got.some((t) => t === "new: baru.txt"), JSON.stringify(got));
    assert.ok(got.some((t) => t === "modified: ada.txt"), JSON.stringify(got));
  });
});
