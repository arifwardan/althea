// Parser stream JSONL muse exec: tool, delta, terminal, passthrough.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExecStream } from "../src/execstream.js";

const ev = (payload_type: string, payload: unknown) =>
  JSON.stringify({ payload_type, payload });

describe("exec stream", () => {
  it("tool proposed → aktivitas + log, dedup per task_id", () => {
    const s = createExecStream();
    const line = ev("task.lifecycle.proposed", {
      event: { kind: "proposed", task_id: "t1", task_kind: "tool.write_file" },
    });
    const a = s.push(line);
    assert.deepEqual(a.activities, [{ kind: "tool", text: "write_file …", tool: "write_file" }]);
    assert.deepEqual(a.log, ["[tool] write_file …"]);
    assert.deepEqual(s.push(line).activities, []); // duplikat diabaikan
  });
  it("tugas non-tool diabaikan", () => {
    const s = createExecStream();
    const r = s.push(ev("task.lifecycle.proposed", {
      event: { kind: "proposed", task_id: "t9", task_kind: "model.meta.response" },
    }));
    assert.deepEqual(r.activities, []);
    assert.deepEqual(r.log, []);
  });
  it("tool.result → aktivitas ✓/✕ + baris pertama hasil", () => {
    const s = createExecStream();
    const ok = s.push(ev("tool.result", {
      correlation_facts: { tool_name: "read_file", outcome: "success" },
      text: "Read text file `/a/b.txt`.\n1|x",
    }));
    assert.deepEqual(ok.activities, [{ kind: "tool", text: "read_file ✓ — Read text file `/a/b.txt`.", tool: "read_file", ok: true }]);
    const bad = s.push(ev("tool.result", {
      correlation_facts: { tool_name: "bash", outcome: "denied" },
      text: "ditolak",
    }));
    assert.match(bad.activities[0].text, /bash ✕/);
    assert.equal(bad.activities[0].tool, "bash");
    assert.equal(bad.activities[0].ok, false);
  });
  it("delta diakumulasi, terminal completed otoritatif", () => {
    const s = createExecStream();
    assert.equal(s.push(ev("run.output.delta", { text: "halo " })).text, "halo ");
    assert.equal(s.push(ev("run.output.delta", { text: "dunia" })).text, "dunia");
    assert.equal(s.transcript(), "halo dunia");
    s.push(ev("run.terminal.completed", { text: "FINAL" }));
    assert.equal(s.transcript(), "FINAL");
  });
  it("baris non-JSON diteruskan ke log + transkrip", () => {
    const s = createExecStream();
    const r = s.push("muse: workspace root: /x (cwd default)");
    assert.deepEqual(r.log, ["muse: workspace root: /x (cwd default)"]);
    assert.match(s.transcript(), /workspace root/);
  });
  it("status model → log; reminder + noise diabaikan", () => {
    const s = createExecStream();
    const m = s.push(ev("task.lifecycle.status", {
      event: { kind: "status", message: "opening meta model stream attempt 1/10" },
    }));
    assert.deepEqual(m.log, ["[model] opening meta model stream attempt 1/10"]);
    assert.deepEqual(m.activities, []);
    const n = s.push(ev("task.lifecycle.status", {
      event: { kind: "status", message: "reminder check" },
    }));
    assert.deepEqual(n.log, []);
    const t = s.push(ev("task.stream.linked", { kind: "task_stream_linked" }));
    assert.deepEqual(t.log, []);
    assert.deepEqual(t.activities, []);
  });
  it("lifecycle failed → aktivitas note + log peringatan", () => {
    const s = createExecStream();
    const r = s.push(ev("task.lifecycle.failed", {
      event: { kind: "failed", reason: "boom" },
    }));
    assert.deepEqual(r.activities, [{ kind: "note", text: "gagal: boom" }]);
    assert.deepEqual(r.log, ["[!] boom"]);
  });
});
