// src/commands/basic.js
// /start, /help, /model, /models, /reset

import { sendTelegram } from "../telegram.js";
import { getActiveModel, setActiveModel, resolveModelLabel, sendModelList, findProviderForModel } from "../models.js";
import { getCavemanMode, setCavemanMode } from "../storage.js";
import { getCustomTools, deleteCustomTool } from "../skills.js";
import { ZEN_MODELS } from "../config.js";

const HELP_TEXT =
  "Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model sesi\n/models - daftar model\n/reset - hapus memori chat sesi\n/myid - lihat Telegram ID kamu\n/caveman - toggle mode hemat token\n/zen - info model Zen (gratis & premium)\n/skills - lihat skill custom\n/delskill <nama> - hapus skill custom\n/newproject <nama> [template] - buat project (worker-hello|worker-api|ai-chat) + repo GitHub\n/projects - list project\n/storage - status D1\n/cleanup - rekomendasi hapus (FILO)\n/purge <nama> yes - hapus dari D1\n/need-supabase <nama> - buat project Supabase\n/login-gh /token-gh <pat> /gh-status /logout-gh - kelola GitHub\n/login-sb /token-sb <pat> /sb-status /logout-sb - kelola Supabase\n/changeapi <url> <key> - ganti API sekaligus (provider + key)\n/changekey <key> - ganti key, provider tetap\n/api-status - lihat API aktif\n/resetapi - kembali ke default\n/addprovider <id> <url> <key> [models] - tambah provider\n/providers - lihat semua provider\n\nKirim dokumen: PDF, DOCX, HTML, TXT, MD, atau gambar (OCR otomatis).\nKetik teks bebas untuk chat AI.\nBuat skill baru: bilang \"buatkan tool...\" lalu konfirmasi.";

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
      await sendModelList(env, chatId, `Model aktif: ${activeModel}\nGanti: /model <nama>\n(ganti model otomatis ganti provider)`);
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    // Strip provider suffix if user typed model:provider
    const modelName = target.split(":")[0];
    // Try to find provider that has this model
    const found = await findProviderForModel(env, modelName);
    if (found) {
      const saveName = `${modelName}:${found.provider_id}`;
      await setActiveModel(env, chatId, saveName);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model: ${modelName}\nProvider: ${found.provider_id}`);
      return true;
    }
    // Fallback: try as-is (for models with explicit provider suffix)
    const resolved = await resolveModelLabel(env, target);
    if (!resolved) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model "${modelName}" tidak dikenal. Gunakan /models untuk lihat.`);
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

  if (cmdWord === "/caveman") {
    const current = await getCavemanMode(env, chatId);
    let newState;
    if (cmdArg === "on") newState = true;
    else if (cmdArg === "off") newState = false;
    else newState = !current;
    await setCavemanMode(env, chatId, newState);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, newState ? "Caveman mode: ON (jawaban hemat token)" : "Caveman mode: OFF (jawaban normal)");
    return true;
  }

  if (cmdWord === "/skills") {
    const tools = await getCustomTools(env, chatId);
    if (!tools.length) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Belum ada skill custom.\nBuat baru: bilang \"buatkan tool...\" atau \"buatkan skill...\"");
    } else {
      const list = tools.map((t) => `- ${t.tool_name}: ${t.description}`).join("\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Skill custom (${tools.length}):\n${list}`);
    }
    return true;
  }

  if (cmdWord === "/delskill") {
    const toolName = cmdArg.trim();
    if (!toolName) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delskill <nama_skill>");
      return true;
    }
    const deleted = await deleteCustomTool(env, chatId, toolName);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, deleted ? `Skill "${toolName}" dihapus.` : `Skill "${toolName}" tidak ditemukan.`);
    return true;
  }

  if (cmdWord === "/zen") {
    const target = cmdArg.trim().toLowerCase();
    if (!target || target === "list") {
      const freeChat = ZEN_MODELS.filter((m) => m.price === "FREE" && !["muse-spark-1.3-contributor-free"].includes(m.id)).map((m) => `  ${m.id} — ${m.name}`).join("\n");
      const freeOther = ZEN_MODELS.filter((m) => m.price === "FREE" && ["muse-spark-1.3-contributor-free"].includes(m.id)).map((m) => `  ${m.id} — ${m.name} (Responses API)`).join("\n");
      const paidChat = ZEN_MODELS.filter((m) => m.price !== "FREE").map((m) => `  ${m.id} — ${m.name} (${m.price}/1M tok)`).join("\n");
      const msg = `OpenCode Zen — Model AI terkurasi.\n\nGratis (Chat Completions - compatible):\n${freeChat}\n\nGratis (butuh endpoint lain, belum compatible):\n${freeOther}\n\nPremium (bayar per token):\n${paidChat}\n\nCara pakai:\n1. Buat akun + API key di opencode.ai/auth\n2. Atur key: /changekey <zen_api_key>\n3. Pilih model: /model deepseek-v4-flash\n(Otomatis pakai provider Zen)\n\nCatatan: Model gratis lainnya (MiMo, Nemotron, Big Pickle, Ling, DeepSeek Flash) sudah compatible.`;
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, msg);
      return true;
    }
    if (target === "free") {
      const freeModels = ZEN_MODELS.filter((m) => m.price === "FREE" && !["muse-spark-1.3-contributor-free"].includes(m.id)).map((m) => `${m.id} — ${m.name}`).join("\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model gratis Zen (compatible):\n${freeModels}\n\nPakai: /model <id_model>:zen`);
      return true;
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /zen atau /zen list atau /zen free");
    return true;
  }

  return false;
}
