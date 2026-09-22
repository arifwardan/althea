// Laporan ringkas: status stack, approval, tidur/limit, 10 event terakhir.
import type { AltheaState } from "./state.js";
import { fmtTok, totalTok } from "./tokens.js";

export function buildReport(s: AltheaState): string {
  const c = (st: string) => s.stack.filter((t) => t.status === st).length;
  const u = s.usage;
  const lines = [
    "📋 LAPORAN ALTHEA",
    `Aktif: antri ${c("queued")} · jalan ${c("running")} · izin ${c("waiting_approval")}`,
    `Selesai: ✅ ${c("done")} · ❌ ${c("failed")}`,
    `🔢 Token (estimasi): ~${fmtTok(totalTok(u))} total (${fmtTok(u.tokIn)} in/${fmtTok(u.tokOut)} out) · ${u.runs} run`,
    s.sleepUntil ? `😴 Tidur s/d ${s.sleepUntil}` : "🟢 Runtime aktif",
    s.limitCooldownUntil ? `⏳ Cooldown limit s/d ${s.limitCooldownUntil}` : "⚡ Kuota Muse normal",
    s.lastReset ? `🔄 Reset terakhir: ${s.lastReset}` : "🔄 Belum pernah reset",
    ...(s.approvals.length
      ? ["", "— izin pending (web 3 mnt → telegram 3 mnt → auto) —",
        ...s.approvals.map((a) => `· [${a.stage}] ${a.id} — ${a.question}`.slice(0, 160))]
      : []),
    "",
    "— 10 event terakhir —",
    ...s.events.slice(-10).map((e) => `· ${e}`),
  ];
  return lines.join("\n").slice(0, 4000);
}
