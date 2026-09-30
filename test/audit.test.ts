// Audit tool calls panel review: ringkas aktivitas tool per nama.
// Jalankan: npm test (tsx + node:test, tanpa dependensi baru).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeToolCalls } from "../web/src/audit.js";

describe("summarizeToolCalls", () => {
  it("mengelompokkan hasil tool: hitung, ok, fail, urut calls", () => {
    const out = summarizeToolCalls([
      { t: "1", kind: "tool", text: "a …", tool: "browser_navigate" },
      { t: "2", kind: "tool", text: "browser_navigate ✓ — ok", tool: "browser_navigate", ok: true },
      { t: "3", kind: "tool", text: "read_file ✓ — x", tool: "read_file", ok: true },
      { t: "4", kind: "tool", text: "bash ✕ — deny", tool: "bash", ok: false },
      { t: "5", kind: "note", text: "gagal: x" },
      { t: "6", kind: "tool", text: "tanpa nama" },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].tool, "browser_navigate");
    assert.equal(out[0].calls, 1);
    assert.equal(out[0].ok, 1);
    assert.equal(out[0].pending, 1);
    assert.deepEqual(out.map((e) => e.tool), ["browser_navigate", "bash", "read_file"]);
    const bash = out.find((e) => e.tool === "bash");
    assert.equal(bash?.fail, 1);
    assert.equal(bash?.lastOk, false);
  });
  it("proposed tanpa result dihitung gantung (pending), bukan hilang", () => {
    const out = summarizeToolCalls([{ t: "1", kind: "tool", text: "write_file …", tool: "write_file" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].calls, 0);
    assert.equal(out[0].pending, 1);
    assert.equal(out[0].lastOk, null);
  });
  it("kosong → array kosong", () => {
    assert.deepEqual(summarizeToolCalls([]), []);
    assert.deepEqual(summarizeToolCalls(null), []);
  });
});
