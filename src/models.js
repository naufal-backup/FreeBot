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

export async function sendModelList(env, chatId, header) {
  const providers = await getAllProviders(env);
  const buttons = [];
  let rows = [];
  for (const p of providers) {
    const list = await fetchProviderModels(p.base_url, p.api_key);
    if (!list || !list.length) continue;
    for (const m of list) {
      const label = m.disp.length > 30 ? m.disp.slice(0, 27) + "..." : m.disp;
      rows.push({ text: label, callback_data: "model:" + m.id + ":" + p.id });
      if (rows.length >= 2) {
        buttons.push(rows);
        rows = [];
      }
    }
  }
  if (rows.length) buttons.push(rows);
  buttons.push([{ text: " Batal", callback_data: "model:cancel" }]);

  const chunks = await buildModelChunks(env);
  const listText = chunks.join("\n\n");
  await sendTelegramInlineKeyboard(env.TELEGRAM_TOKEN, chatId, header + "\n\n" + listText, buttons);
}

export async function handleModelCallback(callbackData, env, chatId, fromId, callbackQueryId, messageId) {
  const parts = callbackData.split(":");
  if (parts.length < 2) return;
  const action = parts[0];
  if (action !== "model") return;

  if (parts[1] === "cancel") {
    await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Dibatalkan");
    return;
  }

  const modelId = parts[1];
  const providerId = parts[2];
  if (!modelId || !providerId) {
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Data tidak valid");
    return;
  }

  const saveName = modelId + ":" + providerId;
  await setActiveModel(env, chatId, saveName);
  await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
  await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Model: " + modelId);
  await editMessageText(env.TELEGRAM_TOKEN, chatId, messageId, "Model aktif: " + modelId + "\nProvider: " + providerId);
}

/**
 * Resolve the correct API endpoint URL for a given model and provider.
 * Defaults to /chat/completions for all providers.
 */
export function resolveApiEndpoint(base_url, model, providerId) {
  return `${base_url}/chat/completions`;
}

export { maskApiKey };
