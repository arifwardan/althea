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
  listFiles, readProjectFile, projectDiff,
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
    assert.match(addFromZip(s, "dup", "a.zip", zip.toBuffer()).error as string, /sudah ada/);
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
    assert.match(d.stat as string, /baru: f.txt/);
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
