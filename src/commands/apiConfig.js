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
    const modelsStr = args.slice(3).join(" ") || "[]";
    if (!id || !baseUrl || !apiKey) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /addprovider <id> <base_url> <api_key> [model1,model2,...]\n\nContoh:\n/addprovider zen https://opencode.ai/zen/v1 sk-xxx deepseek-v4-flash,mimo-v2.5-free\n/addprovider ag https://generativelanguage.googleapis.com/v1beta/openai AQ.xxx gemini-3.6-flash");
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
    try {
      const testRes = await fetch(baseUrl + "/models", { headers: { Authorization: "Bearer " + apiKey } });
      if (!testRes.ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "API tidak valid (HTTP " + testRes.status + "). Cek base_url dan key.");
        return true;
      }
    } catch (err) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal koneksi: " + err.message);
      return true;
    }
    // Parse models: accept comma-separated or JSON array
    let models = "[]";
    if (modelsStr.startsWith("[")) {
      models = modelsStr;
    } else {
      const arr = modelsStr.split(",").map((s) => s.trim()).filter(Boolean);
      models = JSON.stringify(arr);
    }
    await env.DB.prepare(
      "INSERT OR REPLACE INTO provider_configs (id, base_url, api_key, label, models, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, baseUrl, apiKey, id, models, Date.now(), Date.now()).run();
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Provider " + id + " ditambahkan.\nGunakan /model <nama_model> untuk ganti model.");
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
        if (m.length > 0) modelsList = "\nModels: " + m.join(", ");
      } catch {}
      return p.id + ": " + p.base_url + " [" + maskApiKey(p.api_key) + "]" + modelsList;
    });
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Provider:\n\n" + blocks.join("\n\n") + "\n\nGanti model: /model <nama_model>");
    return true;
  }

  return false;
}
