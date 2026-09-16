// src/telegram.js
// All direct interaction with the Telegram Bot API: sending messages,
// documents, chat actions, deleting messages, and voice-note transcription.

import { markdownToHtml } from "./utils/markdown.js";
import { arrayBufferToBase64 } from "./utils/format.js";

export async function sendTelegram(botToken, chat_id, text) {
  const html = markdownToHtml(text);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

export async function sendTelegramDocument(botToken, chatId, fileName, content) {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const blob = new Blob([content], { type: "text/plain; charset=utf-8" });
    formData.append("document", blob, fileName);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error("sendDocument failed:", JSON.stringify(errData));
      return { ok: false, error: errData?.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("sendDocument error:", err.message);
    return { ok: false, error: err.message };
  }
}

export async function deleteTelegramMessage(botToken, chat_id, message_id) {
  if (!message_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, message_id })
    });
  } catch {
    // best effort
  }
}

export async function sendChatAction(botToken, chat_id) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, action: "typing" })
    });
  } catch {
    // best effort
  }
}

export async function transcribeVoiceNote(env, voiceInfo, chatId) {
  try {
    if (voiceInfo.duration > 60) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Voice terlalu panjang (maks 60 detik).");
      return null;
    }
    if (voiceInfo.file_size > 20 * 1024 * 1024) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Voice terlalu besar (maks 20MB).");
      return null;
    }
    if (!env.AUDIO_TRANSCRIBE && (!env.AUDIO_URL || !env.AUDIO_SECRET)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Audio transcriber belum dikonfigurasi.");
      return null;
    }

    await sendChatAction(env.TELEGRAM_TOKEN, chatId);

    const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: voiceInfo.file_id })
    });
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengambil file voice.");
      return null;
    }

    const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
    if (!audioRes.ok) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengunduh voice.");
      return null;
    }

    const audioBuf = await audioRes.arrayBuffer();
    const contentType = audioRes.headers.get("content-type") || "audio/ogg";

    let transcribeRes;
    const audioHeaders = {
      "Content-Type": "application/json",
      ...(env.AUDIO_SECRET ? { "X-Audio-Secret": env.AUDIO_SECRET } : {})
    };

    if (env.AUDIO_TRANSCRIBE) {
      transcribeRes = await env.AUDIO_TRANSCRIBE.fetch("https://audio-transcribe/transcribe", {
        method: "POST",
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType })
      });
    } else {
      transcribeRes = await fetch(`${env.AUDIO_URL}/transcribe`, {
        method: "POST",
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType })
      });
    }

    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok || !transcribeData?.text) {
      console.error("Transcribe error:", JSON.stringify(transcribeData).slice(0, 300));
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mentranskripsi voice.");
      return null;
    }
    return String(transcribeData.text).trim();
  } catch (err) {
    console.error("transcribeVoiceNote error:", err.message);
    try {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Terjadi error saat proses voice.");
    } catch {
      // best effort
    }
    return null;
  }
}
