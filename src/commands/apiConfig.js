// src/commands/apiConfig.js
// /addprovider, /providers, /delprovider

import { sendTelegram } from "../telegram.js";
import { maskApiKey } from "../utils/format.js";

export async function handleApiCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
  if (cmdWord === "/addprovider") {
    const args = cmdArg.split(/\s+/).filter(Boolean);
    const id = (args[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const baseUrl = (args[1] || "").replace(/\/+$/, "");
    const apiKey = args[2] || "";
    if (!id || !baseUrl || !apiKey) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /addprovider <id> <base_url> <api_key>\n\nContoh:\n/addprovider zen https://opencode.ai/zen/v1 sk-xxx\n/addprovider ag https://generativelanguage.googleapis.com/v1beta/openai AQ.xxx");
      return true;
    }
    if (!/^https?:\/\//.test(baseUrl)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Base URL harus diawali http:// atau https://");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    // Fetch models from provider API
    let models = [];
    try {
      const testRes = await fetch(baseUrl + "/models", { headers: { Authorization: "Bearer " + apiKey } });
      if (!testRes.ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "API tidak valid (HTTP " + testRes.status + "). Cek base_url dan key.");
        return true;
      }
      const data = await testRes.json();
      if (Array.isArray(data?.data)) {
        models = data.data
          .filter((m) => typeof m?.id === "string" && m.id)
          .map((m) => m.id.replace(/^models\//, ""));
      }
    } catch (err) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal koneksi: " + err.message);
      return true;
    }
    const modelsJson = JSON.stringify(models);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO provider_configs (id, base_url, api_key, label, models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, baseUrl, apiKey, id, modelsJson, Date.now(), Date.now()).run();
    const modelList = models.length > 0 ? models.slice(0, 10).join(", ") + (models.length > 10 ? " (+" + (models.length - 10) + " lainnya)" : "") : "(tidak ada model)";
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Provider " + id + " ditambahkan.\nModels: " + modelList + "\n\nGanti model: /model <nama_model>");
    return true;
  }

  if (cmdWord === "/delprovider") {
    const id = (cmdArg.split(/\s+/)[0] || "").toLowerCase();
    if (!id) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delprovider <id>");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    await env.DB.prepare("DELETE FROM provider_configs WHERE id = ?").bind(id).run();
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Provider " + id + " dihapus.");
    return true;
  }

  if (cmdWord === "/providers") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const rows = await env.DB.prepare("SELECT id, api_key, base_url, models FROM provider_configs").all();
    if (!rows.results || rows.results.length === 0) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Belum ada provider. Tambah dengan /addprovider");
      return true;
    }
    const blocks = (rows.results || []).map((p) => {
      let modelsList = "";
      try {
        const m = JSON.parse(p.models || "[]");
        if (m.length > 0) modelsList = "\nModels: " + m.slice(0, 8).join(", ") + (m.length > 8 ? " (+" + (m.length - 8) + ")" : "");
      } catch {}
      return p.id + ": " + p.base_url + " [" + maskApiKey(p.api_key) + "]" + modelsList;
    });
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Provider:\n\n" + blocks.join("\n\n") + "\n\nGanti model: /model <nama_model>");
    return true;
  }

  return false;
}
