// Bot Telegram: notif + FLOW IZIN approve/reject. Tanpa lib, pakai fetch long-poll.
// Perintah admin: /status /stack /lapor /tidur <mnt> /bangun /tambah J|prompt
//   /setuju <id> /tolak <id> [alasan] /batal <id>  + tombol inline Setuju/Tolak.
import { config } from "./config.js";
import type { AltheaState } from "./state.js";
import { logEvent } from "./state.js";
import { pushTask, resolveApproval, cancelTask, stackSummary } from "./workflow.js";
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
    `🔐 IZIN DIPERLUKAN (dari web, tanpa respons)\n${title}\nID: ${taskId}\n\n${question}\n\n` +
    `Balas /setuju ${taskId} atau /tolak ${taskId} alasan\n` +
    `⏳ Tanpa respons ${deadlineMinutes} menit → Althea memutuskan sendiri.`;
  const markup = {
    inline_keyboard: [[
      { text: "✅ Setuju", callback_data: `ok:${taskId}` },
      { text: "⛔ Tolak", callback_data: `no:${taskId}` },
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

async function handleCommand(s: AltheaState, chatId: number, text: string, save: () => void): Promise<string> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/status": {
      const tidur = isSleeping(s) ? `😴 tidur s/d ${s.sleepUntil}` : "🟢 aktif";
      const limit = s.limitCooldownUntil ? `\n⏳ cooldown limit s/d ${s.limitCooldownUntil}` : "";
      return `${tidur}${limit}\nApproval pending: ${s.approvals.length}\nTugas di stack: ${s.stack.length}`;
    }
    case "/stack":
      return stackSummary(s);
    case "/lapor":
      return buildReport(s);
    case "/tidur": {
      const mnt = Number(rest[0]) || 60;
      const until = goSleep(s, mnt);
      save();
      return `😴 Tidur ${mnt} mnt (s/d ${until}). Tetap bangun untuk Telegram/approval/reset.`;
    }
    case "/bangun":
      forceWake(s, "perintah /bangun");
      save();
      return "🟢 Bangun. Loop lanjut.";
    case "/tambah": {
      const i = arg.indexOf("|");
      if (i < 0) return "Format: /tambah Judul | prompt lengkap";
      const t = pushTask(s, arg.slice(0, i).trim(), arg.slice(i + 1).trim(), "via telegram");
      forceWake(s, "tugas baru");
      save();
      return `➕ Masuk stack: ${t.id} — ${t.title}`;
    }
    case "/setuju": {
      const id = rest[0] || "";
      const ok = resolveApproval(s, id, true, "disetujui admin", "admin-telegram");
      if (ok) forceWake(s, `approval ${id}`);
      save();
      return ok ? `✅ ${id} disetujui → lanjut.` : `ID ${id} tidak ditemukan.`;
    }
    case "/tolak": {
      const id = rest[0] || "";
      const alasan = rest.slice(1).join(" ") || "ditolak via Telegram";
      const ok = resolveApproval(s, id, false, alasan, "admin-telegram");
      save();
      return ok ? `⛔ ${id} ditolak.` : `ID ${id} tidak ditemukan.`;
    }
    case "/batal": {
      const id = rest[0] || "";
      killRunning();
      const ok = cancelTask(s, id, "dibatalkan via Telegram");
      if (ok) forceWake(s, `batal ${id}`);
      save();
      return ok ? `🛑 ${id} dibatalkan.` : `ID ${id} tidak aktif.`;
    }
    default:
      return "Perintah: /status /stack /lapor /tidur <mnt> /bangun /tambah J|prompt /setuju <id> /tolak <id> /batal <id>";
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
        if (!isAdmin(chatId)) { await answerCallback(u.callback_query.id, "Bukan admin."); continue; }
        const [aksi, id] = u.callback_query.data.split(":");
        if (aksi === "ok" || aksi === "no") {
          const ok = resolveApproval(s, id, aksi === "ok", aksi === "ok" ? "tombol setuju" : "tombol tolak", "admin-telegram");
          if (ok && aksi === "ok") forceWake(s, `approval ${id}`);
          save();
          await answerCallback(u.callback_query.id, ok ? (aksi === "ok" ? "Disetujui." : "Ditolak.") : "ID tidak ada.");
          if (chatId) await tgSend(String(chatId), ok ? (aksi === "ok" ? `✅ ${id} lanjut.` : `⛔ ${id} ditolak.`) : "ID tidak dikenal.");
        }
        continue;
      }
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = msg.chat.id;
      if (!isAdmin(chatId)) continue;
      forceWake(s, "pesan telegram"); // tidur pun bangun saat admin menyapa
      const balas = await handleCommand(s, chatId, msg.text, save);
      logEvent(s, `tg ${chatId}: ${msg.text.slice(0, 80)}`);
      await tgSend(String(chatId), balas);
    }
  } catch { /* jaringan gagal → coba lagi poll berikut */ }
  finally { polling = false; }
}
