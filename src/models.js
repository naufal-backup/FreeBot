// src/models.js
// Manages active AI model per chat, provider configs, and API resolution.
// NO hardcoded models — everything from D1 provider_configs.

import { maskApiKey } from "./utils/format.js";
import { sendTelegram, sendTelegramInlineKeyboard, editMessageText, editMessageReplyMarkup, editMessageKeyboard, answerCallbackQuery } from "./telegram.js";

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

const modelPickMemory = new Map(); // pickId -> { items, provs, prov }
const PAGE_SIZE = 16; // 8 rows x 2 + nav row = 9 rows (Telegram max 10)

function buildPickId(chatId) {
  return "p:" + String(chatId).slice(0, 10);
}

function providerButtons(provs) {
  const buttons = [];
  let row = [];
  provs.forEach((p, i) => {
    const label = p.length > 32 ? p.slice(0, 29) + "..." : p;
    row.push({ text: label, callback_data: "mpv:" + i });
    if (row.length === 2) { buttons.push(row); row = []; }
  });
  if (row.length) buttons.push(row);
  buttons.push([{ text: "✖️ Tutup", callback_data: "m:c" }]);
  return buttons;
}

function modelPageButtons(state, page) {
  const { items, prov } = state;
  const filtered = [];
  items.forEach((m, gi) => { if (m.provider === prov) filtered.push({ m, gi }); });
  const total = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, total - 1));
  const slice = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const buttons = [];
  let row = [];
  for (const { m, gi } of slice) {
    const label = m.disp.length > 32 ? m.disp.slice(0, 29) + "..." : m.disp;
    row.push({ text: label, callback_data: "m:" + gi });
    if (row.length === 2) { buttons.push(row); row = []; }
  }
  if (row.length) buttons.push(row);
  const nav = [];
  if (page > 0) nav.push({ text: "◀️ Prev", callback_data: "mp:" + (page - 1) });
  nav.push({ text: `Hal ${page + 1}/${total}`, callback_data: "noop" });
  if (page < total - 1) nav.push({ text: "Next ▶️", callback_data: "mp:" + (page + 1) });
  nav.push({ text: "🔙 Provider", callback_data: "mb" });
  buttons.push(nav);
  return { buttons, count: filtered.length, page, total };
}

export async function sendModelList(env, chatId, header) {
  const allModels = await getAllModels(env);
  if (!allModels.length) {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, header + "\n\nBelum ada provider. Tambah dengan /addprovider");
    return;
  }
  const items = allModels.map((m) => ({ realLabel: m.realLabel, disp: m.disp, provider: m.provider }));
  const provs = [];
  for (const m of items) if (!provs.includes(m.provider)) provs.push(m.provider);
  const state = { items, provs, prov: null };
  modelPickMemory.set(buildPickId(chatId), state);
  await sendTelegramInlineKeyboard(
    env.TELEGRAM_TOKEN,
    chatId,
    header + "\n\n" + items.length + " model dari " + provs.length + " provider.\n\nPilih provider:",
    providerButtons(provs)
  );
}

export async function handleModelCallback(callbackData, env, chatId, fromId, callbackQueryId, messageId) {
  const pickId = buildPickId(chatId);
  const state = modelPickMemory.get(pickId);

  if (callbackData === "noop") {
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "");
    return;
  }

  if (callbackData.startsWith("mpv:")) {
    if (!state) { await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Kedaluwarsa. Kirim /model lagi."); return; }
    const pi = parseInt(callbackData.slice(4), 10);
    state.prov = state.provs[pi];
    const r = modelPageButtons(state, 0);
    await editMessageKeyboard(env.TELEGRAM_TOKEN, chatId, messageId, `Provider: ${state.prov}\n${r.count} model. Pilih model:`, r.buttons);
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "");
    return;
  }

  if (callbackData.startsWith("mp:")) {
    if (!state || !state.prov) { await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Kedaluwarsa. Kirim /model lagi."); return; }
    const r = modelPageButtons(state, parseInt(callbackData.slice(3), 10) || 0);
    await editMessageKeyboard(env.TELEGRAM_TOKEN, chatId, messageId, `Provider: ${state.prov}\n${r.count} model. Pilih model:`, r.buttons);
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "");
    return;
  }

  if (callbackData === "mb") {
    if (!state) { await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Kedaluwarsa. Kirim /model lagi."); return; }
    state.prov = null;
    await editMessageKeyboard(env.TELEGRAM_TOKEN, chatId, messageId, `Pilih provider:`, providerButtons(state.provs));
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "");
    return;
  }

  if (!callbackData.startsWith("m:")) return;
  const payload = callbackData.slice(2);

  if (payload === "c") {
    await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Dibatalkan");
    return;
  }

  const idx = parseInt(payload, 10);
  if (!state || !state.items[idx]) {
    await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Kedaluwarsa. Kirim /model lagi.");
    return;
  }

  const chosen = state.items[idx];
  await setActiveModel(env, chatId, chosen.realLabel);
  modelPickMemory.delete(pickId);
  await editMessageReplyMarkup(env.TELEGRAM_TOKEN, chatId, messageId, []);
  await answerCallbackQuery(env.TELEGRAM_TOKEN, callbackQueryId, "Tersimpan ✓");
  await editMessageText(env.TELEGRAM_TOKEN, chatId, messageId, "Model aktif: " + chosen.disp + "\nProvider: " + chosen.provider);
}

/**
 * Resolve the correct API endpoint URL for a given model and provider.
 * Defaults to /chat/completions for all providers.
 */
export function resolveApiEndpoint(base_url, model, providerId) {
  return `${base_url}/chat/completions`;
}

export { maskApiKey };
