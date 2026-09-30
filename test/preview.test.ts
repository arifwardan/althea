// Preview aplikasi: command default, port, guard path statis, siklus hidup proses.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
// Catatan: pakai node:http mentah, bukan fetch() global — fetch mengunci proxy
// env yang dibaca sekali saat startup (`npm test` sudah membersihkannya).
import { describe, it } from "node:test";
import http from "node:http";

/** GET via node:http mentah (abaikan proxy env). */
const httpGet = (url: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => resolve({ status: res.statusCode || 0, body: b }));
    }).on("error", reject);
  });
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultCommand, resolveCommand, splitCmd, claimPort, portOpen,
  resolvePreviewPath, isStaticDir, createPreviewManager, previewUrlFor,
  isMonorepo, previewNote, isStandardStack, previewKind, siteDomain, siteUrl,
  linkSite, lerdAvailable,
} from "../src/preview.js";

const tmp = (files = {}) => {
  const d = mkdtempSync(path.join(tmpdir(), "althea-pv-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(d, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return d;
};

describe("command", () => {
  it("default per stack; override menang; kosong bila tak ada default", () => {
    assert.equal(defaultCommand("node"), "npm run dev");
    assert.match(defaultCommand("python") || "", /{port}/);
    assert.equal(defaultCommand("go"), null);
    assert.equal(defaultCommand("generic"), null);
    assert.equal(resolveCommand("go", "go run . --port {port}"), "go run . --port {port}");
    assert.equal(resolveCommand("node", ""), "npm run dev");
    assert.equal(resolveCommand("go", "   "), "");
  });
  it("splitCmd menghormati kutip", () => {
    assert.deepEqual(splitCmd(`node server.js --port 9111`), ["node", "server.js", "--port", "9111"]);
    assert.deepEqual(splitCmd(`npm run "dev: watch"`), ["npm", "run", "dev: watch"]);
    assert.deepEqual(splitCmd(`go run .`), ["go", "run", "."]);
  });
  it("stack standar = Laravel (artisan + laravel/framework)", () => {
    const std = tmp({
      "artisan": "#!/usr/bin/env php",
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }),
      "package.json": JSON.stringify({ dependencies: { svelte: "^5.0.0" } }),
    });
    assert.equal(isStandardStack(std), true);
    assert.equal(previewKind("node", std, false), "herd");
    assert.equal(previewNote("node", std), null);
    const noArtisan = tmp({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }) });
    assert.equal(isStandardStack(noArtisan), false);
    const plain = tmp({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    assert.equal(isStandardStack(plain), false);
  });
  it("non-standar tanpa command = preview not available", () => {
    const vite = tmp({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
    assert.equal(defaultCommand("node", vite), null);
    assert.equal(previewKind("node", vite, false), "none");
    assert.match(previewNote("node", vite) || "", /not available/);
    const dj = tmp({ "manage.py": "x", "requirements.txt": "Django" });
    assert.equal(defaultCommand("python", dj), null);
    assert.equal(previewKind("python", dj, false), "none");
    // Command tersimpan/manual = escape hatch → server.
    assert.equal(previewKind("node", vite, true), "server");
    assert.equal(resolveCommand("node", "node custom.js", vite), "node custom.js");
    const mono = tmp({ "package.json": JSON.stringify({ scripts: { dev: "turbo run dev" } }), "turbo.json": "{}" });
    assert.match(previewNote("node", mono) || "", /monorepo/);
  });
  it("domain lerd aman dari nama project", () => {
    assert.equal(siteDomain("Simalik"), "simalik.test");
    assert.equal(siteDomain("pos kasir!"), "pos-kasir.test");
    assert.equal(siteUrl("simalik"), "https://simalik.test");
  });
});

describe("previewUrlFor", () => {
  it("port terisi → langsung ke port (origin sendiri); tanpa port → fallback path", () => {
    assert.equal(previewUrlFor("web", "server", 9111), "http://127.0.0.1:9111/");
    assert.equal(previewUrlFor("web", "static", 9112), "http://127.0.0.1:9112/");
    assert.equal(previewUrlFor("web", "static", null), "/api/projects/web/preview-file/");
    assert.equal(previewUrlFor("a b", "static", null), "/api/projects/a%20b/preview-file/");
  });
});

describe("port", () => {
  it("claimPort di rentang & berbeda tiap klaim", async () => {
    const used = new Set();
    const a = await claimPort(9111, used);
    assert.ok(a !== null && a >= 9111 && a < 9201);
    used.add(a);
    const b = await claimPort(9111, used);
    assert.ok(b !== null && b !== a);
  });
  it("portOpen jujur: tertutup vs terbuka", async () => {
    const used = new Set();
    const p = await claimPort(9111, used);
    assert.equal(await portOpen(p, 300), false);
    const mgr = createPreviewManager({ basePort: p, readyTimeoutMs: 8000 });
    const cmd = `${process.execPath} -e "require('http').createServer((a,b)=>b.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"`;
    const info = await mgr.start("probe", tmp(), cmd);
    assert.equal(info.state, "running");
    assert.equal(info.reachable, true);
    assert.equal(await portOpen(info.port, 1000), true);
    mgr.stopAll();
    let closed = false; // beri jeda wajar: SIGTERM butuh momen hingga port lepas
    for (let i = 0; i < 25 && !closed; i++) {
      closed = !(await portOpen(info.port, 300));
      if (!closed) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(closed, true);
  });
});

describe("statis", () => {
  it("isStaticDir: index.html tanpa package.json", () => {
    assert.equal(isStaticDir(tmp({ "index.html": "<h1>x</h1>" })), true);
    assert.equal(isStaticDir(tmp({ "index.html": "x", "package.json": "{}" })), false);
    assert.equal(isStaticDir(tmp({})), false);
  });
  it("resolvePreviewPath menolak traversal, melayani folder→index", () => {
    const d = tmp({ "index.html": "home", "sub/about/index.html": "about", "a.css": "x" });
    assert.ok(resolvePreviewPath(d, "")?.endsWith("index.html"));
    assert.ok((resolvePreviewPath(d, "sub/about/") || "").endsWith(path.join("sub", "about", "index.html")));
    assert.equal(resolvePreviewPath(d, "../../etc/passwd"), null);
    assert.equal(resolvePreviewPath(d, "..%2F..%2Fx"), null);
    assert.equal(resolvePreviewPath(d, "tak-ada.css"), null);
    assert.ok(resolvePreviewPath(d, "a.css")?.endsWith("a.css"));
  });
});

describe("manager", () => {
  it("start → running → stop; command jelek → failed jujur", async () => {
    const mgr = createPreviewManager({ basePort: 9181, readyTimeoutMs: 8000 });
    const dir = tmp({ "index.html": "x" });
    const cmd = `${process.execPath} -e "require('http').createServer((a,b)=>b.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')"`;
    const info = await mgr.start("web", dir, cmd);
    assert.equal(info.state, "running");
    assert.ok(mgr.portOf("web") !== null);
    assert.equal(info.url, `http://127.0.0.1:${info.port}/`);
    assert.ok((info.logs.join("\n")).includes("$ "));
    assert.equal(mgr.stop("web"), true);
    assert.equal(mgr.portOf("web"), null);
    const bad = await mgr.start("hantu", dir, "perintah-tak-ada-xyz --x");
    assert.equal(bad.state, "failed");
    assert.ok(bad.error);
    mgr.stopAll();
  });
  it("stop mematikan sepohon proses (cucu tak menahan port)", async () => {
    if (process.platform === "win32") return; // kill grup proses POSIX saja
    const mgr = createPreviewManager({ basePort: 9161, readyTimeoutMs: 8000 });
    try {
      const dir = tmp({
        "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
        "server.js": "require('http').createServer((a,b)=>b.end('x')).listen(Number(process.env.PORT),'127.0.0.1');",
      });
      const info = await mgr.start("pohon", dir, "npm run dev");
      assert.equal(info.state, "running");
      assert.equal(info.port !== null && (await portOpen(info.port, 500)), true);
      assert.equal(mgr.stop("pohon"), true);
      let closed = false; // cucu ikut mati → port lepas
      for (let i = 0; i < 25 && !closed; i++) {
        closed = !(await portOpen(info.port as number, 300));
        if (!closed) await new Promise((r) => setTimeout(r, 200));
      }
      assert.equal(closed, true);
    } finally {
      mgr.stopAll();
    }
  });
  it("link lerd via shim; biner hilang → gagal jujur", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "althea-lerd-"));
    const shim = path.join(bin, "lerd");
    writeFileSync(shim, "#!/bin/sh\necho linked $2\n");
    chmodSync(shim, 0o755);
    const prev = process.env.LERD_BIN;
    try {
      process.env.LERD_BIN = shim;
      assert.equal(await lerdAvailable(), true);
      const r = await linkSite("simalik", tmp({}));
      assert.equal(r.ok, true);
      assert.match(r.output, /linked simalik/);
      process.env.LERD_BIN = path.join(bin, "tak-ada");
      assert.equal(await lerdAvailable(), false);
      const r2 = await linkSite("simalik", tmp({}));
      assert.equal(r2.ok, false);
    } finally {
      if (prev === undefined) delete process.env.LERD_BIN;
      else process.env.LERD_BIN = prev;
    }
  });
  it("guard: run-script tanpa package.json lokal ditolak (anti-climb)", async () => {
    const mgr = createPreviewManager({ basePort: 9165, readyTimeoutMs: 3000 });
    try {
      const dir = tmp({ "server.js": "x" }); // tanpa package.json
      const r = await mgr.start("climb", dir, "npm run dev");
      assert.equal(r.state, "failed");
      assert.match(r.error || "", /package\.json/);
    } finally {
      mgr.stopAll();
    }
  });
  it("status tanpa proses: statis auto-jalan di port sendiri; server → stopped + cmd", async () => {
    const mgr = createPreviewManager({ basePort: 9191 });
    try {
      const dir = tmp({ "index.html": "<h1>x</h1>", "a.css": "x" });
      const st = await mgr.status("s", dir, "generic", "");
      assert.equal(st.state, "running");
      assert.equal(st.mode, "static");
      assert.equal(st.url, `http://127.0.0.1:${st.port}/`);
      // Disajikan betulan via HTTP, termasuk aset absolut di root sendiri.
      const home = await httpGet(st.url);
      assert.match(home.body, /<h1>x<\/h1>/);
      const css = await httpGet(new URL("/a.css", st.url).href);
      assert.equal(css.status, 200);
      assert.equal(mgr.stop("s"), true);
      const sv = await mgr.status("g", tmp({ "go.mod": "module x" }), "go", "");
      assert.equal(sv.state, "stopped");
      assert.equal(sv.cmd, null);
      const sv2 = await mgr.status("g", tmp({ "go.mod": "module x" }), "go", "go run .");
      assert.equal(sv2.cmd, "go run .");
    } finally {
      mgr.stopAll(); // selalu tutup server: tanpa ini proses test gantung
    }
  });
});
