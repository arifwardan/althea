// Penerjemah stream JSONL `muse exec --json` → baris log ramah + aktivitas.
// Bentuk event (terverifikasi dari run nyata):
// - task_kind "tool.<nama>" (proposed) = tool dipanggil (argumen TAK diekspos CLI)
// - "tool.result" {correlation_facts.tool_name, text, outcome} = hasil tool
// - "run.output.delta" {text} = potongan jawaban akhir (streaming)
// - "run.terminal.completed" {text} = jawaban akhir utuh (otoritatif)
// - task.lifecycle.status {message} = status model (kecuali reminder.*)
// Baris non-JSON (mis. "muse: ...") diteruskan apa adanya.
export interface StreamActivity {
  kind: "tool" | "file" | "note";
  text: string;
  tool?: string; // nama tool (kind tool saja) — untuk audit terstruktur
  ok?: boolean; // hasil tool.result: true sukses, false gagal/deny
}

export interface StreamPush {
  log: string[]; // baris ramah untuk onLine
  activities: StreamActivity[]; // entri ringkas untuk feed aktivitas
  text: string; // potongan transkrip (jawaban akhir)
}

export interface ExecStream {
  push(line: string): StreamPush;
  transcript(): string;
}

export function createExecStream(): ExecStream {
  const seenTasks = new Set<string>();
  const chunks: string[] = [];
  let terminal: string | null = null;
  const empty = (): StreamPush => ({ log: [], activities: [], text: "" });

  return {
    push(line: string): StreamPush {
      const r = empty();
      const t = line.trim();
      if (!t) return r;
      let o: Record<string, unknown> | null = null;
      try {
        const v: unknown = JSON.parse(t);
        if (v && typeof v === "object") o = v as Record<string, unknown>;
      } catch { /* bukan JSON → passthrough di bawah */ }
      if (!o) {
        r.log.push(line);
        r.text = line + "\n";
        chunks.push(line + "\n");
        return r;
      }
      const pt = String(o.payload_type || "");
      const p = (o.payload || {}) as Record<string, unknown>;
      const ev = (p.event || {}) as Record<string, unknown>;
      if (pt === "run.output.delta" && typeof p.text === "string") {
        r.text = p.text;
        chunks.push(p.text);
        return r;
      }
      if (pt.startsWith("run.terminal.") && typeof p.text === "string") {
        terminal = p.text;
        if (!chunks.length) r.text = p.text;
        return r;
      }
      if (pt === "task.lifecycle.proposed" && String(ev.task_kind || "").startsWith("tool.")) {
        const id = String(ev.task_id || "");
        if (id && seenTasks.has(id)) return r;
        if (id) seenTasks.add(id);
        const name = String(ev.task_kind).slice("tool.".length);
        r.activities.push({ kind: "tool", text: `${name} …`, tool: name });
        r.log.push(`[tool] ${name} …`);
        return r;
      }
      if (pt === "tool.result") {
        const cf = (p.correlation_facts || {}) as Record<string, unknown>;
        const name = String(cf.tool_name || "tool");
        const okRes = cf.outcome === "success";
        const first = String(p.text || "").split("\n")[0].trim().slice(0, 140);
        const mark = okRes ? "✓" : "✕";
        const text = first ? `${name} ${mark} — ${first}` : `${name} ${mark}`;
        r.activities.push({ kind: "tool", text, tool: name, ok: okRes });
        r.log.push(`[tool] ${text}`);
        return r;
      }
      if (pt === "task.lifecycle.status" && typeof ev.message === "string") {
        if (/reminder/i.test(ev.message)) return r;
        r.log.push(`[model] ${ev.message.slice(0, 200)}`);
        return r;
      }
      if (pt === "task.lifecycle.failed") {
        const reason = String(ev.reason || "failed").slice(0, 200);
        if (/reminder/i.test(reason)) return r;
        r.activities.push({ kind: "note", text: `failed: ${reason}` });
        r.log.push(`[!] ${reason}`);
        return r;
      }
      return r; // event lain (lifecycle noise, turn, session) diabaikan
    },
    transcript(): string {
      return terminal ?? chunks.join("");
    },
  };
}
