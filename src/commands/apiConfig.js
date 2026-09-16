// src/commands/apiConfig.js
// /changeapi, /changeprovider, /changekey, /api-status, /resetapi,
// /addprovider, /delprovider, /providers

import { sendTelegram, deleteTelegramMessage } from "../telegram.js";
import { maskApiKey } from "../utils/format.js";
import { DEFAULT_API_BASE } from "../config.js";
import { getApiConfig, setApiConfig, setApiBase, setApiKey, clearApiConfig } from "../models.js";

export async function handleApiCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
  if (cmdWord === "/changeapi") {
    const args = cmdArg.split(/\s+/).filter(Boolean);
    const baseUrl = args[0] || "";
    const apiKey = args.slice(1).join(" ") || "";
    if (!baseUrl || !apiKey) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changeapi <base_url> <api_key>\nContoh: /changeapi https://api.kelontongai.id/v1 sk-xxx...");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    try {
      const testRes = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!testRes.ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API tidak valid (HTTP ${testRes.status}). Cek base_url dan key.`);
        return true;
      }
    } catch (err) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke API: ${err.message}`);
      return true;
    }
    await setApiConfig(env, baseUrl, apiKey);
    await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API diganti ke: ${baseUrl}\n(Simpan, pesan key dihapus.)`);
    return true;
  }

  if (cmdWord === "/changeprovider") {
    const baseUrl = (cmdArg.trim() || "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changeprovider <base_url>\nContoh: /changeprovider https://api.kelontongai.id/v1\n(Key tetap dipertahankan.)");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const existing = await getApiConfig(env);
    const apiKey = existing?.api_key || env.EXTERNAL_API_KEY || "";
    try {
      const testRes = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!testRes.ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider tidak valid (HTTP ${testRes.status}). Cek base_url & key aktif.`);
        return true;
      }
    } catch (err) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke provider: ${err.message}`);
      return true;
    }
    await setApiBase(env, baseUrl);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider diganti ke: ${baseUrl}\nKey tetap: ${maskApiKey(apiKey)}`);
    return true;
  }

  if (cmdWord === "/changekey") {
    const apiKey = cmdArg.split(/\s+/)[0] || "";
    if (apiKey.length < 10) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changekey <api_key>\nKey terlalu pendek. Contoh: /changekey sk-xxx...");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const existing = await getApiConfig(env);
    const base_url = existing?.base_url || DEFAULT_API_BASE;
    try {
      const testRes = await fetch(`${base_url}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!testRes.ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key tidak valid untuk ${base_url} (HTTP ${testRes.status}).`);
        return true;
      }
    } catch (err) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi: ${err.message}`);
      return true;
    }
    await setApiKey(env, apiKey);
    await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key API diganti (provider: ${base_url}). Pesan key dihapus.`);
    return true;
  }

  if (cmdWord === "/api-status") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    const config = await getApiConfig(env);
    if (config) {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        `API aktif: ${config.base_url}\nKey: ${maskApiKey(config.api_key)}\n\n/resetapi untuk kembali ke default.`
      );
    } else {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API default: ${DEFAULT_API_BASE}\nGunakan /changeapi untuk ganti.`);
    }
    return true;
  }

  if (cmdWord === "/resetapi") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
      return true;
    }
    await clearApiConfig(env);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API dikembalikan ke default: ${DEFAULT_API_BASE}`);
    return true;
  }

  if (cmdWord === "/addprovider") {
    const args = cmdArg.split(/\s+/).filter(Boolean);
    const id = (args[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const baseUrl = (args[1] || "").replace(/\/+$/, "");
    const apiKey = args[2] || "";
    const label = args.slice(3).join(" ") || id;
    if (!id || !baseUrl || !apiKey) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /addprovider <id> <base_url> <api_key> [label]");
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
    await env.DB.prepare(
      "INSERT OR REPLACE INTO provider_configs (id, base_url, api_key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, baseUrl, apiKey, label, Date.now(), Date.now()).run();
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "\u2705 Provider **" + label + "** (" + id + ") ditambahkan.");
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
    const rows = await env.DB.prepare("SELECT id, label, api_key, base_url FROM provider_configs").all();
    const blocks = (rows.results || []).map(
      (p) => "- **" + (p.label || p.id) + "** (" + p.id + "): " + p.base_url + " [" + maskApiKey(p.api_key) + "]"
    );
    blocks.push("- **default** (geraikita): " + DEFAULT_API_BASE + " [" + maskApiKey(env.EXTERNAL_API_KEY) + "]  (via EXTERNAL_API_KEY)");
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "**Provider terdaftar:**\n" + blocks.join("\n") + "\n\nGunakan format model:provider untuk memilih.");
    return true;
  }

  return false;
}
