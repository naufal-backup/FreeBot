// src/storage.js
// D1-backed persistence helpers: connected service tokens (GitHub/Supabase),
// project storage accounting, and chat memory (with summarization).

import { SUMMARY_MAX_CHARS } from "./config.js";
import { getActiveApi } from "./models.js";

export async function getServiceToken(env, fromId, service) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT token FROM service_tokens WHERE owner_id = ? AND service = ?"
  ).bind(String(fromId), service).first();
  return row?.token || null;
}

export async function getStorageUsage(env) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare("SELECT SUM(total_bytes) AS s FROM projects").first();
  return Number(row?.s || 0);
}

export async function getChatMemory(env, chatId) {
  if (!env.DB) return [];
  try {
    const row = await env.DB.prepare("SELECT history FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).first();
    if (!row?.history) return [];
    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveChatMemory(env, chatId, history) {
  if (!env.DB) return;
  try {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO chat_memory (chat_id, history, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(String(chatId), JSON.stringify(history), now, now).run();
  } catch (err) {
    console.error("saveChatMemory failed:", err.message);
  }
}

// --- Caveman mode per-chat preference ---

export async function getCavemanMode(env, chatId) {
  if (!env.DB) return false;
  const row = await env.DB.prepare("SELECT caveman_mode FROM user_preferences WHERE chat_id = ?")
    .bind(String(chatId)).first();
  return row?.caveman_mode === 1;
}

export async function setCavemanMode(env, chatId, enabled) {
  if (!env.DB) return false;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO user_preferences (chat_id, caveman_mode) VALUES (?, ?)"
  ).bind(String(chatId), enabled ? 1 : 0).run();
  return true;
}

export async function summarizeHistory(env, model, history) {
  try {
    const { base_url, api_key } = await getActiveApi(env);
    const res = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "Kamu adalah perangkum percakapan yang teliti. Dari isi percakapan berikut, hasilkan ringkasan yang MEMPERTAHANKAN KONTEKS penting dengan lengkap, dalam Bahasa Indonesia: (1) topik-topik yang dibahas, (2) fakta yang user sebut (nama, proyek, angka, preferensi), (3) keputusan/kesepakatan, (4) nada dan hubungan. Tulis sebagai poin-poin jelas, jangan buang detail pada 20 pesan terakhir (itu dikelola terpisah). Jangan menambahkan informasi yang tidak ada. Maksimal 6000 karakter."
          },
          ...history
        ],
        max_tokens: 2000
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    const trimmed = text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!trimmed) return null;
    return [{ role: "system", content: `Ringkasan percakapan sebelumnya:\n${trimmed}` }];
  } catch {
    return null;
  }
}
