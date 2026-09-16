// src/models.js
// Manages active AI model per chat, provider configs, and the "active API"
// (base_url + api_key) resolution used for every completion request.

import { DEFAULT_API_BASE, FALLBACK_MODELS, ZEN_API_BASE } from "./config.js";
import { maskApiKey } from "./utils/format.js";
import { sendTelegram } from "./telegram.js";

export async function getActiveModel(env, chatId) {
  const fallback = env.AI_MODEL || "deepseek-v4-flash";
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare("SELECT model FROM chat_settings WHERE chat_id = ?").bind(String(chatId)).first();
    return row?.model || fallback;
  } catch {
    return fallback;
  }
}

export async function setActiveModel(env, chatId, model) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO chat_settings (chat_id, model, updated_at) VALUES (?, ?, ?)"
  ).bind(String(chatId), model, Date.now()).run();
}

export async function getApiConfig(env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT base_url, api_key FROM api_config WHERE id = ?").bind("active").first();
    return row ? { base_url: row.base_url, api_key: row.api_key } : null;
  } catch {
    return null;
  }
}

export async function setApiConfig(env, base_url, api_key) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO api_config (id, base_url, api_key, updated_at) VALUES (?, ?, ?, ?)"
  ).bind("active", base_url, api_key, Date.now()).run();
}

export async function setApiBase(env, base_url) {
  const existing = await getApiConfig(env);
  const api_key = existing?.api_key || env.EXTERNAL_API_KEY || "";
  await setApiConfig(env, base_url, api_key);
}

export async function setApiKey(env, api_key) {
  const existing = await getApiConfig(env);
  const base_url = existing?.base_url || DEFAULT_API_BASE;
  await setApiConfig(env, base_url, api_key);
}

export async function clearApiConfig(env) {
  if (!env.DB) return;
  await env.DB.prepare("DELETE FROM api_config WHERE id = ?").bind("active").run();
}

export async function getActiveApi(env, chatId) {
  if (chatId && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT model FROM chat_settings WHERE chat_id = ?").bind(String(chatId)).first();
      const prov = (row?.model || "").split(":")[1] || "";
      if (prov) {
        const p = await env.DB.prepare("SELECT base_url, api_key FROM provider_configs WHERE id = ?").bind(prov).first();
        if (p) return { base_url: p.base_url, api_key: p.api_key };
      }
    } catch {
      // fall through to default config
    }
  }
  const config = await getApiConfig(env);
  return config ? { base_url: config.base_url, api_key: config.api_key } : { base_url: DEFAULT_API_BASE, api_key: env.EXTERNAL_API_KEY };
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
    try {
      const cfg = await env.DB.prepare("SELECT base_url, api_key FROM api_config WHERE id = 'active'").first();
      if (cfg) list.unshift({ id: "default", base_url: cfg.base_url, api_key: cfg.api_key, label: "default" });
    } catch {
      // ignore
    }
  }
  if (!list.length) list.push({ id: "geraikita", base_url: DEFAULT_API_BASE, api_key: env.EXTERNAL_API_KEY, label: "geraikita" });
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
  const withProv = models.find((m) => m.dispLabel === t || m.realLabel === t);
  if (withProv) return withProv.realLabel;
  const bare = models.find((m) => m.disp === t || m.id === t);
  if (bare) return bare.realLabel;
  return FALLBACK_MODELS.includes(t) ? t : null;
}

export async function buildModelChunks(env) {
  const providers = await getAllProviders(env);
  const chunks = [];
  const LIMIT = 3600;
  for (const p of providers) {
    const list = await fetchProviderModels(p.base_url, p.api_key);
    if (!list || !list.length) continue;
    const lines = list.map((m) => "  " + m.disp + ":" + p.id);
    let buf = "\u{1F50C} " + (p.label || p.id) + " (" + p.id + ") \u2014 " + list.length + " model\n";
    for (const line of lines) {
      if (buf.length + line.length + 1 > LIMIT) {
        chunks.push(buf.trimEnd());
        buf = "\u{1F50C} " + (p.label || p.id) + " (" + p.id + ") lanjutan\n";
      }
      buf += line + "\n";
    }
    if (buf.trim()) chunks.push(buf.trimEnd());
  }
  if (!chunks.length) chunks.push("(tidak ada provider yang berhasil memuat daftar model)");
  return chunks;
}

export async function sendModelList(env, chatId, header) {
  const chunks = await buildModelChunks(env);
  await sendTelegram(env.TELEGRAM_TOKEN, chatId, header + "\n\n" + chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "(" + (i + 1) + "/" + chunks.length + ")\n" + chunks[i]);
  }
}

// Zen models that use /responses endpoint (OpenAI format)
const ZEN_RESPONSES_MODELS = /^(gpt-|grok-|muse-spark)/;
// Zen models that use /messages endpoint (Anthropic format)
const ZEN_MESSAGES_MODELS = /^(claude-|qwen)/;
// Zen models that use /chat/completions endpoint (OpenAI-compatible)
const ZEN_CHAT_COMPLETIONS_MODELS = /^(deepseek-|minimax-|glm-|kimi-|mimo-|nemotron-|big-pickle|ling-)/;

/**
 * Resolve the correct API endpoint URL for a given model and provider.
 * Zen uses different endpoints depending on the model type.
 */
export function resolveApiEndpoint(base_url, model, providerId) {
  if (providerId !== "zen") {
    return `${base_url}/chat/completions`;
  }
  const bareModel = (model || "").split(":")[0];
  if (ZEN_RESPONSES_MODELS.test(bareModel)) {
    return `${ZEN_API_BASE}/responses`;
  }
  if (ZEN_MESSAGES_MODELS.test(bareModel)) {
    return `${ZEN_API_BASE}/messages`;
  }
  return `${ZEN_API_BASE}/chat/completions`;
}

/**
 * Check if a model/provider combination uses Anthropic messages format.
 */
export function isAnthropicFormat(model, providerId) {
  if (providerId === "zen") {
    const bareModel = (model || "").split(":")[0];
    return ZEN_MESSAGES_MODELS.test(bareModel);
  }
  return false;
}

export { maskApiKey };
