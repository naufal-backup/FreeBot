// src/models.js
// Manages active AI model per chat, provider configs, and API resolution.
// NO hardcoded models — everything from D1 provider_configs.

import { maskApiKey } from "./utils/format.js";
import { sendTelegram, sendTelegramInlineKeyboard, editMessageText, editMessageReplyMarkup, answerCallbackQuery } from "./telegram.js";

export async function getActiveModel(env, chatId) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT model FROM chat_settings WHERE chat_id = ?").bind(String(chatId)).first();
    return row?.model || null;
  } catch {
    return null;
  }
}

export async function setActiveModel(env, chatId, model) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO chat_settings (chat_id, model, updated_at) VALUES (?, ?, ?)"
  ).bind(String(chatId), model, Date.now()).run();
}

/**
 * Get API config for the active model of a chat.
 * Parses model string like "deepseek-v4-flash:zen" to find provider.
 * Returns { base_url, api_key } or null if no provider found.
 */
export async function getActiveApi(env, chatId) {
  if (!chatId || !env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT model FROM chat_settings WHERE chat_id = ?").bind(String(chatId)).first();
    const prov = (row?.model || "").split(":")[1] || "";
    if (prov) {
      const p = await env.DB.prepare("SELECT base_url, api_key FROM provider_configs WHERE id = ?").bind(prov).first();
      if (p) return { base_url: p.base_url, api_key: p.api_key };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Find which provider supports a given model name.
 * Live-fetches models from each provider's API.
 */
export async function findProviderForModel(env, modelName) {
  if (!env.DB) return null;
  try {
    const rows = await env.DB.prepare("SELECT id, base_url, api_key FROM provider_configs").all();
    for (const p of rows.results || []) {
      const liveModels = await fetchProviderModels(p.base_url, p.api_key);
      if (liveModels && liveModels.some((m) => m.id === modelName || m.disp === modelName)) {
        return { provider_id: p.id, base_url: p.base_url, api_key: p.api_key };
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function getAllProviders(env) {
  const list = [];
  if (env.DB) {
    try {
      const rows = await env.DB.prepare("SELECT id, base_url, api_key, label FROM provider_configs").all();
      for (const p of rows.results || []) list.push(p);
    } catch {
      // ignore
    }
  }
  return list;
}

export async function fetchProviderModels(baseUrl, apiKey) {
  try {
    const res = await fetch(baseUrl + "/models", {
      headers: { Authorization: "Bearer " + apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.data)) return null;
    return data.data
      .filter((m) => typeof m?.id === "string" && m.id)
      .map((m) => ({ id: m.id, disp: m.id.replace(/^models\//, "") }));
  } catch {
    return null;
  }
}

export async function getAllModels(env) {
  const providers = await getAllProviders(env);
  const out = [];
  for (const p of providers) {
    const list = await fetchProviderModels(p.base_url, p.api_key);
    if (!list || !list.length) continue;
    for (const m of list) {
      out.push({
        real: m.id,
        disp: m.disp,
        provider: p.id,
        realLabel: m.id + ":" + p.id,
        dispLabel: m.disp + ":" + p.id
      });
    }
  }
  return out;
}

export async function resolveModelLabel(env, target) {
  if (!target) return null;
  const models = await getAllModels(env);
  const t = target.trim();
  // Try exact match with provider suffix
  const withProv = models.find((m) => m.dispLabel === t || m.realLabel === t);
  if (withProv) return withProv.realLabel;
  // Try bare name match
  const bare = models.find((m) => m.disp === t || m.id === t);
  if (bare) return bare.realLabel;
  return null;
}

export async function buildModelChunks(env) {
  const providers = await getAllProviders(env);
  const chunks = [];
  const LIMIT = 3600;
  for (const p of providers) {
    const list = await fetchProviderModels(p.base_url, p.api_key);
    if (!list || !list.length) continue;
    const lines = list.map((m) => "  " + m.disp + ":" + p.id);
    let buf = (p.label || p.id) + " (" + p.id + ") — " + list.length + " model\n";
    for (const line of lines) {
      if (buf.length + line.length + 1 > LIMIT) {
        chunks.push(buf.trimEnd());
        buf = (p.label || p.id) + " (" + p.id + ") lanjutan\n";
      }
      buf += line + "\n";
    }
    if (buf.trim()) chunks.push(buf.trimEnd());
  }
  if (!chunks.length) chunks.push("Belum ada provider. Tambah dengan /addprovider");
  return chunks;
}

const modelPickMemory = new Map();

function buildPickId(chatId) {
  return "p:" + String(chatId).slice(0, 10);
}

export async function sendModelList(env, chatId, header) {
  const allModels = await getAllModels(env);
  const pickId = buildPickId(chatId);
  const items = allModels.map((m) => ({
    realLabel: m.realLabel,
    disp: m.disp
  }));
  modelPickMemory.set(pickId, items);

  const buttons = [];
  let rows = [];
  for (let i = 0; i < items.length; i++) {
    const label = items[i].disp.length > 30 ? items[i].disp.slice(0, 27) + "..." : items[i].disp;
    rows.push({ text: label, callback_data: "m:" + i });
    if (rows.length >= 2) {
      buttons.push(rows);
      rows = [];
    }
  }
  if (rows.length) buttons.push(rows);
  buttons.push([{ text: " Batal", callback_data: "m:c" }]);

  const chunks = await buildModelChunks(env);
  const listText = chunks.join("\n\n");
  await sendTelegramInlineKeyboard(env.TELEGRAM_TOKEN, chatId, header + "\n\n" + listText, buttons);
}

export async function handleModelCallback(callbackData, env, chatId, fromId, callbackQueryId, messageId) {
  if (!callbackData.startsWith("m:")) return;
  const payload = callbackData.slice(2);

  if (payload === "c") {
    await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Dibatalkan");
    return;
  }

  const idx = parseInt(payload, 10);
  const pickId = buildPickId(chatId);
  const items = modelPickMemory.get(pickId);
  if (!items || !items[idx]) {
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Kedaluwarsa. Kirim /model lagi.");
    return;
  }

  const chosen = items[idx];
  const saveName = chosen.realLabel;
  await setActiveModel(env, chatId, saveName);
  modelPickMemory.delete(pickId);
  await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
  await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Model: " + chosen.disp);
  await editMessageText(env.TELEGRAM_TOKEN, chatId, messageId, "Model aktif: " + chosen.disp + "\nProvider: " + saveName.split(":")[1]);
}

/**
 * Resolve the correct API endpoint URL for a given model and provider.
 * Defaults to /chat/completions for all providers.
 */
export function resolveApiEndpoint(base_url, model, providerId) {
  return `${base_url}/chat/completions`;
}

export { maskApiKey };
