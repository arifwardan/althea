// Bot Telegram: notif + FLOW IZIN approve/reject. Tanpa lib, pakai fetch long-poll.
// Perintah admin: /status /stack /lapor /tidur <mnt> /bangun /tambah J|prompt
//   /setuju <id> /tolak <id> [alasan] /batal <id>  + tombol inline Setuju/Tolak.
import { config } from "./config.js";
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";
import { pushTask, resolveApproval, cancelTask, stackSummary } from "./workflow.js";
import { matchDestructive } from "./escalation.js";
import { pipelineOnFail, pipelineOnCancel } from "./pipeline.js";
import { killRunning } from "./claude.js";
import { goSleep, forceWake, isSleeping } from "./sleeper.js";
import { buildReport } from "./report.js";

const api = (m: string) => `https://api.telegram.org/bot${config.telegramToken}/${m}`;

export function isAdmin(chatId: number | string): boolean {
  if (config.adminIds.length === 0) return true; // belum dikunci → terima semua (mode laptop awal)
  return config.adminIds.includes(String(chatId));
}

export async function tgSend(chatId: string, text: string, replyMarkup?: unknown): Promise<void> {
  if (!config.telegramToken) return;
  try {
    await fetch(api("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), reply_markup: replyMarkup }),
    });
  } catch { /* abaikan, loop tetap hidup */ }
}

export async function notifyAdmins(text: string, replyMarkup?: unknown): Promise<void> {
  const ids = config.adminIds.length > 0 ? config.adminIds : [];
  if (ids.length === 0) return; // tanpa admin terdaftar, notif hanya ke log
  await Promise.all(ids.map((id) => tgSend(id, text, replyMarkup)));
}

/** Kirim permintaan izin dengan tombol inline Setuju/Tolak. */
export async function askApproval(
  taskId: string, title: string, question: string, deadlineMinutes = 3
): Promise<void> {
  const text =
    `Approval needed\nTask: ${title} (${taskId})\n\n${question}\n\n` +
    `Reply /approve ${taskId} or /reject ${taskId} <reason>\n` +
    `No reply within ${deadlineMinutes} min → Althea decides alone.`;
  const markup = {
    inline_keyboard: [[
      { text: "Approve", callback_data: `ok:${taskId}` },
      { text: "Reject", callback_data: `no:${taskId}` },
    ]],
  };
  await notifyAdmins(text, markup);
}

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: { id: string; message?: { chat: { id: number } }; data?: string };
}

let offset = 0;

async function answerCallback(id: string, text: string): Promise<void> {
  try {
    await fetch(api("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: id, text: text.slice(0, 180) }),
    });
  } catch { /* abaikan */ }
}

export async function handleCommand(s: AltheaState, chatId: number, text: string, save: () => void): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/status": {
      const lines = [
        isSleeping(s) ? `Status: sleeping until ${s.sleepUntil}` : "Status: active",
        ...(isSleeping(s) ? ["Wakes for: Telegram, approvals, resets"] : []),
        ...(s.limitCooldownUntil ? [`Limit cooldown until: ${s.limitCooldownUntil}`] : []),
        `Pending approvals: ${s.approvals.length}`,
        `Tasks on stack: ${s.stack.length}`,
      ];
      return lines.join("\n");
    }
    case "/stack":
      return stackSummary(s);
    case "/report":
      return buildReport(s);
    case "/sleep": {
      const mnt = Number(rest[0]) || 60;
      const until = goSleep(s, mnt);
      save();
      return `Sleeping for ${mnt} min (until ${until}).\nStill wakes for Telegram, approvals, and resets.`;
    }
    case "/wake":
      forceWake(s, "/wake command");
      save();
      return "Awake. Loop continues.";
    case "/add": {
      const i = arg.indexOf("|");
      if (i < 0) return "Usage: /add Title | full prompt (any language — Althea translates it to English)";
      const t = pushTask(s, arg.slice(0, i).trim(), arg.slice(i + 1).trim(), "via telegram");
      forceWake(s, "new task");
      save();
      return `Queued: ${t.id} — ${t.title}`;
    }
    case "/ask": {
      const q = arg.trim();
      if (!q) return "Usage: /ask <question> (any language — answered only, nothing is changed)";
      const t = pushTask(s, `ask: ${q.slice(0, 60)}`, q, "via telegram", undefined, undefined, { askOnly: true });
      forceWake(s, "new ask task");
      save();
      return `Queued: ${t.id} — the answer will be sent here. Nothing will be changed.`;
    }
    case "/prompt": {
      const p = arg.trim();
      if (!p) return "Usage: /prompt <text> (any language — except destructive actions)";
      const hit = matchDestructive(p);
      if (hit) {
        return `Rejected: destructive prompt (matched "${hit}").\nRephrase without delete/uninstall/format/drop/shutdown actions, or run it step by step from the dashboard where you approve each action.`;
      }
      const t = pushTask(s, p.slice(0, 60) || "telegram prompt", p, "via telegram");
      forceWake(s, "new task");
      save();
      return `Queued: ${t.id} — ${t.title}`;
    }
    case "/approve": {
      const id = rest[0] || "";
      const ok = resolveApproval(s, id, true, "approved by admin", "admin-telegram");
      if (ok) forceWake(s, `approval ${id}`);
      save();
      return ok ? `Approved ${id} — continuing.` : `ID ${id} not found.`;
    }
    case "/reject": {
      const id = rest[0] || "";
      const alasan = rest.slice(1).join(" ") || "rejected via Telegram";
      const ok = resolveApproval(s, id, false, alasan, "admin-telegram");
      if (ok) pipelineOnFail(s, id);
      save();
      return ok ? `Rejected ${id}.` : `ID ${id} not found.`;
    }
    case "/cancel": {
      const id = rest[0] || "";
      killRunning();
      const ok = cancelTask(s, id, "cancelled via Telegram");
      if (ok) {
        pipelineOnCancel(s, id);
        forceWake(s, `cancel ${id}`);
      }
      save();
      return ok ? `Cancelled ${id}.` : `ID ${id} is not active.`;
    }
    default:
      return [
        "Commands:",
        "/status — runtime status",
        "/stack — task stack",
        "/report — full report",
        "/sleep <min> — sleep (default 60)",
        "/wake — wake up",
        "/add Title | prompt — run a task",
        "/ask <question> — answer only, changes nothing",
        "/prompt <text> — run anything except destructive actions",
        "/approve <id> — approve",
        "/reject <id> — reject",
        "/cancel <id> — cancel a task",
      ].join("\n");
  }
}

let polling = false; // cegah overlap: long-poll 20s vs loop 15s

export async function pollTelegram(s: AltheaState, save: () => void): Promise<void> {
  if (!config.telegramToken || polling) return;
  polling = true;
  try {
    const r = await fetch(api(`getUpdates?offset=${offset}&timeout=20`));
    const j = (await r.json()) as { result?: Update[] };
    for (const u of j.result ?? []) {
      offset = u.update_id + 1;
      // Tombol inline approve/reject
      if (u.callback_query?.data) {
        const chatId = u.callback_query.message?.chat.id ?? 0;
        if (!isAdmin(chatId)) { await answerCallback(u.callback_query.id, "Not an admin."); continue; }
        const [aksi, id] = u.callback_query.data.split(":");
        if (aksi === "ok" || aksi === "no") {
          const ok = resolveApproval(s, id, aksi === "ok", aksi === "ok" ? "approve button" : "reject button", "admin-telegram");
          if (ok && aksi === "ok") forceWake(s, `approval ${id}`);
          if (ok && aksi === "no") pipelineOnFail(s, id);
          save();
          await answerCallback(u.callback_query.id, ok ? (aksi === "ok" ? "Approved." : "Rejected.") : "No such ID.");
          if (chatId) await tgSend(String(chatId), ok ? (aksi === "ok" ? `Approved ${id} — continuing.` : `Rejected ${id}.`) : "Unknown ID.");
        }
        continue;
      }
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) continue;
      forceWake(s, "telegram message"); // tidur pun bangun saat admin menyapa
      const balas = await handleCommand(s, chatId, msg.text, save);
      logEvent(s, `tg ${chatId}: ${msg.text.slice(0, 80)}`);
      await tgSend(String(chatId), balas);
    }
  } catch { /* jaringan gagal → coba lagi poll berikut */ }
  finally { polling = false; }
}
