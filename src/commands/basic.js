// src/commands/basic.js
// /start, /help, /model, /models, /reset, /caveman, /skills, /delskill

import { sendTelegram } from "../telegram.js";
import { getActiveModel, setActiveModel, sendModelList, findProviderForModel } from "../models.js";
import { getCavemanMode, setCavemanMode } from "../storage.js";
import { getCustomTools, deleteCustomTool } from "../skills.js";
import { listImages, deleteImage, deleteAllImages } from "../imageStore.js";
import { fmtBytes } from "../utils/format.js";

const HELP_TEXT =
  "Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model\n/models - daftar model dari provider\n/reset - hapus memori chat\n/myid - lihat ID\n/caveman - toggle hemat token\n/skills - lihat skill custom\n/delskill <nama> - hapus skill\n/images - lihat gambar tersimpan\n/delimage <id> - hapus satu gambar\n/clearimages - hapus semua gambar\n/addprovider <id> <url> <key> [models] - tambah provider\n/providers - lihat provider\n/delprovider <id> - hapus provider\n/google-setup - panduan setup Google Cloud\n/google-status - cek status Google integration\n\nKirim dokumen: PDF, DOCX, HTML, TXT, MD, gambar (OCR).\nKirim gambar → bisa jadi poster/flyer/PDF atau disimpan ke repo GitHub.\nKirim link Google Sheets/Docs → bot auto-baca.\nKetik teks bebas untuk chat AI.";

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
      await sendModelList(env, chatId, `Model aktif: ${activeModel || "(belum diset)"}\nGanti: /model <nama_model>`);
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const modelName = target.split(":")[0];
    const found = await findProviderForModel(env, modelName);
    if (found) {
      const saveName = `${modelName}:${found.provider_id}`;
      await setActiveModel(env, chatId, saveName);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model: ${modelName}\nProvider: ${found.provider_id}`);
      return true;
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model "${modelName}" tidak ditemukan di provider manapun.\nGunakan /providers untuk lihat provider dan model yang tersedia.`);
    return true;
  }

  if (cmdWord === "/models") {
    const activeModel = await getActiveModel(env, chatId);
    await sendModelList(env, chatId, `Model aktif: ${activeModel || "(belum diset)"}`);
    return true;
  }

  if (cmdWord === "/reset") {
    if (env.DB) {
      await env.DB.prepare("DELETE FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).run();
    }
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Memori chat dihapus.");
    return true;
  }

  if (cmdWord === "/caveman") {
    const current = await getCavemanMode(env, chatId);
    let newState;
    if (cmdArg === "on") newState = true;
    else if (cmdArg === "off") newState = false;
    else newState = !current;
    await setCavemanMode(env, chatId, newState);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, newState ? "Caveman: ON (hemat token)" : "Caveman: OFF (normal)");
    return true;
  }

  if (cmdWord === "/skills") {
    const tools = await getCustomTools(env, chatId);
    if (!tools.length) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Belum ada skill.\nBuat: bilang \"buatkan tool...\"");
    } else {
      const list = tools.map((t) => `- ${t.tool_name}: ${t.description}`).join("\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Skill (${tools.length}):\n${list}`);
    }
    return true;
  }

  if (cmdWord === "/delskill") {
    const toolName = cmdArg.trim();
    if (!toolName) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delskill <nama>");
      return true;
    }
    const deleted = await deleteCustomTool(env, chatId, toolName);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, deleted ? `"${toolName}" dihapus.` : `"${toolName}" tidak ditemukan.`);
    return true;
  }

  if (cmdWord === "/images") {
    const imgs = await listImages(env, chatId);
    if (!imgs.length) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Belum ada gambar tersimpan.\nKirim gambar ke chat — tersimpan sementara 30 menit.");
      return true;
    }
    const lines = imgs.map((im) => `- id=${im.id} | ${im.fileName} | ${fmtBytes(im.sizeBytes)}`);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gambar tersimpan (${imgs.length}):\n${lines.join("\n")}\n\nHapus satu: /delimage <id>\nHapus semua: /clearimages`);
    return true;
  }

  if (cmdWord === "/delimage") {
    const imageId = cmdArg.trim();
    if (!imageId) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delimage <id>\nLihat id dengan /images.");
      return true;
    }
    const imgs = await listImages(env, chatId);
    if (!imgs.some((im) => im.id === imageId)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gambar id=${imageId} tidak ditemukan (mungkin sudah dihapus/kedaluwarsa).`);
      return true;
    }
    await deleteImage(env, imageId, chatId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `\u2705 Gambar id=${imageId} dihapus.`);
    return true;
  }

  if (cmdWord === "/clearimages") {
    const n = await deleteAllImages(env, chatId);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, n ? `\u2705 ${n} gambar dihapus dari penyimpanan sementara.` : "Tidak ada gambar tersimpan.");
    return true;
  }

  return false;
}
