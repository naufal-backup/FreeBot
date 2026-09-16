// src/commands/auth.js
// /login-gh, /token-gh, /gh-status, /logout-gh, /login-sb, /token-sb, /sb-status, /logout-sb

import { sendTelegram, deleteTelegramMessage } from "../telegram.js";
import { validateGithubToken } from "../github.js";
import { validateSupabaseToken, listSupabaseProjects } from "../supabase.js";
import { getServiceToken } from "../storage.js";

export async function handleAuthCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
  if (cmdWord === "/login-gh") {
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      "Sambung GitHub:\n1. Buka github.com/settings/tokens (Fine-grained, expiry \u22647 hari, scope Contents read-write untuk repo target)\n2. Copy token\n3. Kirim ke sini: /token-gh <token>\nPesan token langsung saya hapus setelah dibaca."
    );
    return true;
  }

  if (cmdWord === "/token-gh") {
    const pat = cmdArg.split(/\s+/)[0] || "";
    if (pat.length < 20) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /token-gh <token>. Token terlalu pendek, cek lagi.");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
      return true;
    }
    const login = await validateGithubToken(pat);
    if (!login) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub tidak valid. Buat baru lalu kirim ulang.");
      return true;
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)"
    ).bind(String(fromId), "github", pat, Date.now()).run();
    await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `GitHub tersambung sebagai @${login}. Pesan token sudah dihapus.`);
    return true;
  }

  if (cmdWord === "/gh-status") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
      return true;
    }
    const pat = await getServiceToken(env, fromId, "github");
    if (!pat) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "GitHub belum tersambung. Kirim /login-gh dulu.");
      return true;
    }
    const login = await validateGithubToken(pat);
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      login ? `GitHub tersambung sebagai @${login}.` : "Token GitHub tersimpan tapi tidak valid lagi. Kirim /token-gh baru atau /logout-gh."
    );
    return true;
  }

  if (cmdWord === "/logout-gh") {
    if (env.DB) {
      await env.DB.prepare("DELETE FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), "github").run();
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub dihapus dari bot. Revoke juga di github.com/settings/tokens.");
    return true;
  }

  if (cmdWord === "/login-sb") {
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      "Sambung Supabase:\n1. Buka supabase.com/dashboard/account/tokens \u2192 Create new token\n2. Copy token (sbp_...)\n3. Kirim ke sini: /token-sb <token>\nPesan token langsung saya hapus setelah dibaca."
    );
    return true;
  }

  if (cmdWord === "/token-sb") {
    const pat = cmdArg.split(/\s+/)[0] || "";
    if (pat.length < 20) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /token-sb <token>. Token terlalu pendek, cek lagi.");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
      return true;
    }
    const ok = await validateSupabaseToken(pat);
    if (!ok) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token Supabase tidak valid. Buat baru lalu kirim ulang.");
      return true;
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)"
    ).bind(String(fromId), "supabase", pat, Date.now()).run();
    await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase tersambung. Pesan token sudah dihapus. Operasi project (/need-supabase) menyusul.");
    return true;
  }

  if (cmdWord === "/sb-status") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
      return true;
    }
    const pat = await getServiceToken(env, fromId, "supabase");
    if (!pat) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase belum tersambung. Kirim /login-sb dulu.");
      return true;
    }
    const names = await listSupabaseProjects(pat);
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      names === null
        ? "Token Supabase tersimpan tapi tidak valid lagi. Kirim /token-sb baru atau /logout-sb."
        : names.length === 0
        ? "Supabase tersambung. Belum ada project."
        : `Supabase tersambung. Projects (${names.length}):\n${names.slice(0, 10).join("\n")}`
    );
    return true;
  }

  if (cmdWord === "/logout-sb") {
    if (env.DB) {
      await env.DB.prepare("DELETE FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), "supabase").run();
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token Supabase dihapus dari bot. Revoke juga di dashboard Supabase.");
    return true;
  }

  return false;
}
