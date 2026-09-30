// MCP: registry, merge settings.json CLI, sync per project.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listServers, findServer, customServers, ownedKey, toEntry,
  settingsPath, mergeMcpSettings, syncProjectMcps, mcpOverview, isRunnable,
} from "../src/mcp.js";

describe("registry", () => {
  it("menyediakan playwright bawaan", () => {
    const ids = listServers({}).map((d) => d.id);
    assert.ok(ids.includes("playwright"));
    const pw = findServer("playwright", {});
    assert.equal(pw?.transport, "stdio");
    assert.ok((pw?.command || [])?.join(" ").includes("@playwright/mcp"));
    assert.ok(pw && pw.setupHint.length > 0);
    const fb = findServer("flowbite", {});
    assert.equal(fb?.transport, "stdio");
    assert.deepEqual(fb?.command, ["npx", "-y", "flowbite-mcp"]);
    assert.deepEqual(toEntry(fb!), { command: "npx", args: ["-y", "flowbite-mcp"] });
    assert.equal(findServer("tak-ada", {}), null);
  });
  it("server kustom via ALTHEA_MCP_SERVERS; entri rusak diabaikan", () => {
    const env = {
      ALTHEA_MCP_SERVERS: JSON.stringify({
        "kbbi": { "command": ["node", "mcp-kbbi.js"], "desc": "KBBI" },
        "rusak": { "command": "bukan-array" },
        "situs?": { "command": ["x"] },
      }),
    };
    const ids = listServers(env).map((d) => d.id);
    assert.ok(ids.includes("playwright"));
    assert.ok(ids.includes("kbbi"));
    assert.ok(!ids.includes("rusak"));
    assert.ok(!ids.includes("situs?"));
    assert.equal(listServers({ BOGUS: "x" }).length, listServers({}).length);
    assert.deepEqual(customServers({ ALTHEA_MCP_SERVERS: "{bukan json" }), []);
  });
  it("toEntry berbentuk map {command,args}/{url}", () => {
    assert.deepEqual(toEntry(findServer("playwright", {})), {
      command: "npx", args: ["-y", "@playwright/mcp"],
    });
    assert.deepEqual(
      toEntry({ id: "h", desc: "", transport: "http", url: "https://x/mcp", setupHint: "" }),
      { url: "https://x/mcp" },
    );
  });
  it("settingsPath menghormati XDG_CONFIG_HOME", () => {
    assert.equal(settingsPath({ XDG_CONFIG_HOME: "/tmp/x", HOME: "/h" }), "/tmp/x/muse/settings.json");
    assert.match(settingsPath({ HOME: "/h" }), /\/h\/.config\/muse\/settings\.json$/);
  });
});

describe("mergeMcpSettings", () => {
  it("file kosong → dokumen baru berisi entri milik Althea", () => {
    const m = mergeMcpSettings(null, { [ownedKey("playwright")]: { command: "npx" } });
    assert.equal(m.ok, true);
    assert.equal(m.changed, true);
    assert.equal(m.doc?.schema_version, 1);
    assert.deepEqual((m.doc?.mcpServers || {})[ownedKey("playwright")], { command: "npx" });
  });
  it("mempertahankan entri user + menambah milik Althea", () => {
    const raw = JSON.stringify({ schema_version: 1, mcpServers: { "punya-user": { command: "x" } }, lain: 1 });
    const m = mergeMcpSettings(raw, { [ownedKey("playwright")]: { command: "npx" } });
    assert.equal(m.ok, true);
    const servers = m.doc?.mcpServers;
    assert.deepEqual(servers["punya-user"], { command: "x" });
    assert.deepEqual(servers[ownedKey("playwright")], { command: "npx" });
    assert.equal(m.doc?.lain, 1);
  });
  it("null menghapus entri milik Althea yang di-disable; user tetap utuh", () => {
    const raw = JSON.stringify({ mcpServers: { "punya-user": { command: "x" }, [ownedKey("playwright")]: { command: "npx" } } });
    const m = mergeMcpSettings(raw, { [ownedKey("playwright")]: null });
    assert.equal(m.ok, true);
    assert.equal(m.changed, true);
    assert.deepEqual(m.doc?.mcpServers, { "punya-user": { command: "x" } });
  });
  it("tak ada perubahan → changed=false", () => {
    const raw = JSON.stringify({ mcpServers: { [ownedKey("playwright")]: { command: "npx" } } });
    const m = mergeMcpSettings(raw, { [ownedKey("playwright")]: { command: "npx" } });
    assert.equal(m.ok, true);
    assert.equal(m.changed, false);
  });
  it("menolak menimpa dokumen rusak / mcpServers bukan object", () => {
    for (const raw of ["{bukan json", "[1,2]", '"str"', JSON.stringify({ mcpServers: [1] }), JSON.stringify({ mcpServers: "x" })]) {
      const m = mergeMcpSettings(raw, { [ownedKey("playwright")]: { command: "npx" } });
      assert.equal(m.ok, false, raw);
      assert.ok(m.error);
    }
  });
});

describe("syncProjectMcps", () => {
  const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "althea-mcp-")), "settings.json");
  const runOk = () => true;

  it("tulis entri saat diaktifkan; hapus saat dimatikan; user utuh", () => {
    const f = tmpFile();
    const r1 = syncProjectMcps(["playwright"], { settingsFile: f, run: runOk, env: {} });
    assert.equal(r1.ok, true);
    assert.equal(r1.changed, true);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    assert.deepEqual(doc.mcpServers[ownedKey("playwright")], { command: "npx", args: ["-y", "@playwright/mcp"] });
    const st = r1.status.find((s) => s.id === "playwright");
    assert.equal(st?.enabled, true);
    assert.equal(st?.present, true);
    assert.equal(st?.runnable, true);
    const r2 = syncProjectMcps([], { settingsFile: f, run: runOk, env: {} });
    assert.equal(r2.changed, true);
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")).mcpServers, {});
  });
  it("id tak dikenal diabaikan; runnable=false dilaporkan jujur", () => {
    const f = tmpFile();
    const r = syncProjectMcps(["playwright", "hantu"], { settingsFile: f, run: () => false, env: {} });
    assert.equal(r.ok, true);
    const st = r.status.find((s) => s.id === "playwright");
    assert.equal(st?.runnable, false);
    assert.ok(!(ownedKey("hantu") in JSON.parse(readFileSync(f, "utf8")).mcpServers));
  });
  it("tak pernah melempar saat settings rusak — tugas boleh lanjut", () => {
    const f = tmpFile();
    writeFileSync(f, "{rusak");
    const r = syncProjectMcps(["playwright"], { settingsFile: f, run: runOk, env: {} });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});

describe("mcpOverview", () => {
  it("baca saja: enabled difilter ke id dikenal, runnable null bila mati", () => {
    const o = mcpOverview(["playwright", "hantu"], { settingsFile: "/tak/ada/settings.json", run: () => true, env: {} });
    assert.deepEqual(o.enabled, ["playwright"]);
    const pw = o.servers.find((s) => s.id === "playwright");
    assert.equal(pw?.enabled, true);
    assert.equal(pw?.present, false);
    assert.equal(pw?.runnable, true);
  });
});

describe("isRunnable", () => {
  it("http selalu true; stdio dicek via run", () => {
    assert.equal(isRunnable({ id: "h", desc: "", transport: "http", url: "https://x", setupHint: "" }), true);
    assert.equal(isRunnable(findServer("playwright", {}), () => true), true);
    assert.equal(isRunnable(findServer("playwright", {}), () => false), false);
  });
});
