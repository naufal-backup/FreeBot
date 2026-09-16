// src/commands/basic.js
// /start, /help, /model, /models, /reset

import { sendTelegram } from "../telegram.js";
import { getActiveModel, setActiveModel, resolveModelLabel, sendModelList } from "../models.js";

const HELP_TEXT =
  "Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model sesi\n/models - daftar model\n/reset - hapus memori chat sesi\n/myid - lihat Telegram ID kamu\n/newproject <nama> [template] - buat project (worker-hello|worker-api|ai-chat) + repo GitHub\n/projects - list project\n/storage - status D1\n/cleanup - rekomendasi hapus (FILO)\n/purge <nama> yes - hapus dari D1\n/need-supabase <nama> - buat project Supabase\n/login-gh /token-gh <pat> /gh-status /logout-gh - kelola GitHub\n/login-sb /token-sb <pat> /sb-status /logout-sb - kelola Supabase\n/changeapi <url> <key> - ganti API sekaligus (provider + key)\n/changeprovider <url> - ganti provider, key tetap\n/changekey <key> - ganti key, provider tetap\n/api-status - lihat API aktif\n/resetapi - kembali ke default\n\nKirim dokumen: PDF, DOCX, HTML, TXT, MD, atau gambar (OCR otomatis).\nKetik teks bebas untuk chat AI.";

export async function handleBasicCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
  if (cmdWord === "/start") {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Halo! Kirim pesan apa saja, saya balas dengan AI.\n\nKetik /help untuk daftar perintah.");
    return true;
  }

  if (cmdWord === "/help") {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, HELP_TEXT);
    return true;
  }

  if (cmdWord === "/model") {
    const activeModel = await getActiveModel(env, chatId);
    const target = cmdArg.split(/\s+/)[0];
    if (!target) {
      await sendModelList(env, chatId, `Model aktif: ${activeModel}\nGanti: /model <nama> (format model:provider)`);
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const resolved = await resolveModelLabel(env, target);
    if (!resolved) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model "${target}" tidak dikenal. Lihat /models.`);
      return true;
    }
    await setActiveModel(env, chatId, resolved);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model sesi ini diganti ke: ${resolved}`);
    return true;
  }

  if (cmdWord === "/models") {
    const activeModel = await getActiveModel(env, chatId);
    await sendModelList(env, chatId, `Model aktif: ${activeModel}`);
    return true;
  }

  if (cmdWord === "/reset") {
    if (env.DB) {
      await env.DB.prepare("DELETE FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).run();
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "\u2705 Memori chat dihapus.");
    return true;
  }

  return false;
}
