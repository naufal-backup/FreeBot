// src/commands/schedule.js
// /cron, /crons, /delcron, /remind, /reminds

import { sendTelegram } from "../telegram.js";
import { parseNaturalTime } from "../utils/time.js";

export async function handleScheduleCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
  if (cmdWord === "/cron") {
    const m = cmdArg.match(/^(\d{1,2}[:.]\d{2})\s+(.+)$/);
    if (!m) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /cron HH:MM tugas\nContoh: /cron 09:00 ringkasan berita AI");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const cronTime = m[1].replace(".", ":");
    await env.DB.prepare("INSERT INTO tasks (owner_id,chat_id,type,cron_time,task_text,active,created_at) VALUES (?,?,?,?,?,1,?)").bind(
      String(fromId),
      String(chatId),
      "cron",
      cronTime,
      m[2],
      Date.now()
    ).run();
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Cron dijadwalkan tiap **" + cronTime + "** WIB: " + m[2]);
    return true;
  }

  if (cmdWord === "/crons") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const rows = await env.DB.prepare(
      "SELECT id,cron_time,task_text,last_run,active FROM tasks WHERE owner_id=? AND type=? ORDER BY cron_time"
    ).bind(String(fromId), "cron").all();
    const list = (rows.results || [])
      .map((t) => "#" + t.id + " **" + t.cron_time + "** " + (t.active ? "\u2705" : "\u26D4") + " " + t.task_text + (t.last_run ? "\n   Terakhir: " + t.last_run.slice(0, 16) : ""))
      .join("\n\n");
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? "**Cron tugas:**\n\n" + list + "\n\nHapus: /delcron <id>" : "Belum ada cron. Buat: /cron HH:MM tugas");
    return true;
  }

  if (cmdWord === "/delcron") {
    const id = parseInt(cmdArg.split(/\s+/)[0], 10);
    if (!id || !env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delcron <id>\nLihat ID via /crons");
      return true;
    }
    await env.DB.prepare("DELETE FROM tasks WHERE id=? AND owner_id=?").bind(id, String(fromId)).run();
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Cron #" + id + " dihapus.");
    return true;
  }

  if (cmdWord === "/remind") {
    const m = cmdArg.match(/^(.+?)\s+(.+)$/);
    if (!m) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /remind <waktu> <pesan>\nContoh: /remind in 45 minutes meeting");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const remindAt = parseNaturalTime(m[1]);
    if (!remindAt) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Waktu tidak dikenali. Contoh: "in 45 minutes", "besok jam 8 pagi"');
      return true;
    }
    await env.DB.prepare("INSERT INTO pending_reminders (owner_id,chat_id,remind_at,message,created_at) VALUES (?,?,?,?,?)").bind(
      String(fromId),
      String(chatId),
      remindAt,
      m[2],
      Date.now()
    ).run();
    const wib = new Date(remindAt + 7 * 3600000);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Pengingat: " + wib.toISOString().replace("T", " ").slice(0, 16) + " WIB \u2014 " + m[2]);
    return true;
  }

  if (cmdWord === "/reminds") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const rows = await env.DB.prepare("SELECT id,remind_at,message,done FROM pending_reminders WHERE owner_id=? ORDER BY remind_at").bind(String(fromId)).all();
    const now = Date.now();
    const list = (rows.results || [])
      .map(
        (r) =>
          (r.done ? "\u2705" : "\u23F3") +
          " #" +
          r.id +
          " " +
          new Date(r.remind_at + 7 * 3600000).toISOString().replace("T", " ").slice(0, 16) +
          " WIB" +
          (r.done ? " (selesai)" : r.remind_at < now ? " (terlewat)" : "") +
          "\n   " +
          r.message
      )
      .join("\n\n");
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? "**Pengingat:**\n\n" + list : "Belum ada pengingat.");
    return true;
  }

  return false;
}
