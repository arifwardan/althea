// Brief report: stack status, approvals, sleep/limit, last 10 events.
import type { AltheaState } from "./state.js";
import { fmtTok, totalTok } from "./tokens.js";

export function buildReport(s: AltheaState): string {
  const c = (st: string) => s.stack.filter((t) => t.status === st).length;
  const u = s.usage;
  const fmtDur = (ms: number | null) =>
    ms === null ? "waiting" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`;
  const lines = [
    "Althea report",
    `Active — queued: ${c("queued")}, running: ${c("running")}, approval: ${c("waiting_approval")}, quota: ${c("waiting_quota")}`,
    `Finished — done: ${c("done")}, failed: ${c("failed")}`,
    `Tokens (est.) — about ${fmtTok(totalTok(u))} total (${fmtTok(u.tokIn)} in / ${fmtTok(u.tokOut)} out), ${u.runs} runs`,
    s.sleepUntil ? `Runtime: sleeping until ${s.sleepUntil}` : "Runtime: active",
    s.limitCooldownUntil ? `Muse quota: cooldown until ${s.limitCooldownUntil}` : "Muse quota: normal",
    s.lastReset ? `Last reset: ${s.lastReset}` : "Last reset: none yet",
    ...((s.quotaHistory || []).length
      ? ["— Quota history (last 5) —",
        ...(s.quotaHistory || []).slice(-5).reverse().map((e) =>
          `· ${e.taskId} "${e.title.slice(0, 40)}": hit ${e.hitAt.slice(11, 19)} → ` +
          (e.resumeAt ? `resumed ${e.resumeAt.slice(11, 19)} (waited ${fmtDur(e.waitMs)})` : `estimated ${e.until.slice(11, 19)}`))]
      : []),
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
