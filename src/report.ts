// Brief report: stack status, approvals, sleep, last 10 events.
import type { AltheaState } from "./state.js";
import { fmtTok, totalTok } from "./tokens.js";

export function buildReport(s: AltheaState): string {
  const c = (st: string) => s.stack.filter((t) => t.status === st).length;
  const u = s.usage;
  const lines = [
    "Althea report",
    `Active — queued: ${c("queued")}, running: ${c("running")}, approval: ${c("waiting_approval")}`,
    `Finished — done: ${c("done")}, failed: ${c("failed")}`,
    `Tokens (est.) — about ${fmtTok(totalTok(u))} total (${fmtTok(u.tokIn)} in / ${fmtTok(u.tokOut)} out), ${u.runs} runs`,
    s.sleepUntil ? `Runtime: sleeping until ${s.sleepUntil}` : "Runtime: active",
    ...(s.approvals.length
      ? ["", "— Pending approvals (web 3 min → telegram 3 min → auto) —",
        ...s.approvals.map((a) => `· [${a.stage}] ${a.id} — ${a.question}`.slice(0, 160))]
      : []),
    "",
    "— Last 10 events —",
    ...s.events.slice(-10).map((e) => `· ${e}`),
  ];
  return lines.join("\n").slice(0, 4000);
}
