// Ringkasan audit tool calls untuk panel review (murni, tanpa dependensi).
// Dipakai web (App.svelte); data mentah berasal dari TaskActivity (tool/ok).

/**
 * Kelompokkan aktivitas tool per nama tool.
 * calls = hasil tercatat + yang masih gantung (proposed tanpa result,
 * mis. run dibatalkan/timeout di tengah tool call).
 */
export function summarizeToolCalls(acts) {
  const map = new Map();
  for (const a of acts || []) {
    if (!a || a.kind !== "tool" || !a.tool) continue;
    let e = map.get(a.tool);
    if (!e) {
      e = { tool: a.tool, calls: 0, ok: 0, fail: 0, pending: 0, last: "", lastOk: null };
      map.set(a.tool, e);
    }
    if (a.ok === true) { e.calls++; e.ok++; }
    else if (a.ok === false) { e.calls++; e.fail++; }
    else e.pending++;
    e.last = a.text || "";
    e.lastOk = a.ok ?? null;
  }
  const out = [...map.values()];
  out.sort((x, y) => (y.calls + y.pending) - (x.calls + x.pending) || (x.tool < y.tool ? -1 : 1));
  return out;
}
