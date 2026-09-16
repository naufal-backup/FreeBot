// src/index.js
// Cloudflare Worker entry point. Wires the Telegram webhook (fetch) and the
// Cron Trigger (scheduled) to the rest of the modules.

import { MAX_TOOL_ITERATIONS, MEMORY_MAX_ENTRIES } from "./config.js";
import { sendTelegram, deleteTelegramMessage, transcribeVoiceNote, sendChatAction } from "./telegram.js";
import { extractDocumentText } from "./documents.js";
import { runScheduledTasks } from "./scheduled.js";
import { canonicalIdentityAnswer } from "./identity.js";
import { getActiveModel, getActiveApi, resolveApiEndpoint } from "./models.js";
import { getChatMemory, saveChatMemory, summarizeHistory, getCavemanMode } from "./storage.js";
import { getAllToolDefinitions } from "./tools/definitions.js";
import { executeTool } from "./tools/executor.js";

import { handleBasicCommands } from "./commands/basic.js";
import { handleAuthCommands } from "./commands/auth.js";
import { handleApiCommands } from "./commands/apiConfig.js";
import { handleProjectCommands } from "./commands/projects.js";
import { handleScheduleCommands } from "./commands/schedule.js";

// Command groups tried, in order, once the user has passed the allow-list
// check. Each handler returns true if it matched & handled the command.
const COMMAND_HANDLERS = [
  handleBasicCommands,
  handleAuthCommands,
  handleApiCommands,
  handleProjectCommands,
  handleScheduleCommands
];

// Serialize AI processing per chat to prevent race conditions
const chatQueues = new Map();

// Per-chat cancellation flag — set by /stop, checked in AI loop
const chatCancelled = new Map();

function enqueueChatTask(chatId, task) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(task, task);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env, ctx));
  },

  async fetch(request, env, ctx) {
    const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (request.method !== "POST" || !env.WEBHOOK_SECRET || secretToken !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("OK", { status: 200 });
    }

    const chatId = update?.message?.chat?.id;
    const voiceInfo = update?.message?.voice;
    const docInfo = update?.message?.document;
    let userText = (update?.message?.text || update?.message?.caption || "").trim();
    const fromId = update?.message?.from?.id;
    const messageId = update?.message?.message_id;

    if (!chatId || !fromId) {
      return new Response("OK", { status: 200 });
    }

    // --- Document ingestion (PDF/DOCX/HTML/TXT/MD/IMAGE) -----------------
    if (docInfo) {
      const fileName = docInfo.file_name || "";
      const mime = docInfo.mime_type || "";
      const supported = /\.(pdf|docx|html?|txt|md|png|jpe?g|webp|gif)$/i.test(fileName) || /pdf|wordprocessingml|html|text\/plain|text\/markdown|image\//i.test(mime);
      if (!supported) {
        userText = userText || '(User mengirim dokumen "' + fileName + '"; format tidak didukung. Yang bisa dibaca: PDF, DOCX, HTML, TXT, MD, gambar.)';
      } else {
        if (docInfo.file_size > 20 * 1024 * 1024) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Ukuran dokumen melebihi batas 20MB.");
          return new Response("OK", { status: 200 });
        }
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Membaca dokumen...");
        try {
          const hint = /\.(pdf)$/i.test(fileName)
            ? "pdf"
            : /\.docx$/i.test(fileName)
            ? "docx"
            : /\.html?$/i.test(fileName)
            ? "html"
            : /\.md$/i.test(fileName)
            ? "markdown"
            : /\.txt$/i.test(fileName)
            ? "text"
            : /\.(png|jpe?g|webp|gif)$/i.test(fileName)
            ? "image"
            : mime.includes("wordprocessingml")
            ? "docx"
            : mime.includes("pdf")
            ? "pdf"
            : mime.includes("html")
            ? "html"
            : mime.startsWith("image/")
            ? "image"
            : "";
          const docController = new AbortController();
          const docTimeout = setTimeout(() => docController.abort(), 45000);
          let text;
          try {
            text = await extractDocumentText(env, docInfo.file_id, fileName, hint);
          } finally {
            clearTimeout(docTimeout);
          }
          if (text && text.trim()) {
            userText =
              'Isi dokumen "' +
              (fileName || "dokumen") +
              '":\n\n' +
              text.trim().slice(0, 15000) +
              (userText ? "\n\nInstruksi user: " + userText : "\n\nRingkas isi dokumen ini.");
          } else {
            userText = userText || 'Dokumen "' + (fileName || "dokumen") + '" tidak memuat teks yang bisa dibaca.';
          }
        } catch (err) {
          console.error("doc extract error:", err.message);
          userText = userText || "Gagal membaca dokumen: " + err.message;
        }
      }
    }

    // --- Voice note transcription -----------------------------------------
    if (!userText && voiceInfo) {
      const transcribed = await transcribeVoiceNote(env, voiceInfo, chatId);
      if (transcribed === null) return new Response("OK", { status: 200 });
      userText = transcribed;
      if (!userText) return new Response("OK", { status: 200 });
    } else if (!userText) {
      return new Response("OK", { status: 200 });
    }

    const cmdWord = userText.split(/\s+/)[0].replace(/_/g, "-");
    const cmdArg = userText.includes(" ") ? userText.slice(userText.indexOf(" ") + 1).trim() : "";

    // --- Commands available to everyone (even before the allow-list) ------
    if (cmdWord === "/stop") {
      chatCancelled.set(chatId, true);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      }).catch(() => {});
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "\u{1F6D1} Semua proses dihentikan.");
      return new Response("OK", { status: 200 });
    }

    if (cmdWord === "/myid") {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Your ID: ${fromId}`);
      return new Response("OK", { status: 200 });
    }

    // --- Allow-list gate ----------------------------------------------------
    const allowed = (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(String(fromId))) {
      console.log(`Blocked unauthorized user: ${fromId}`);
      return new Response("OK", { status: 200 });
    }

    // --- Process remaining commands and AI in chat queue to serialize per-chat ---
    return enqueueChatTask(chatId, async () => {

    // Clear cancellation flag at start of new task
    chatCancelled.delete(chatId);

    // --- Slash commands -------------------------------------------------
    if (cmdWord.startsWith("/")) {
      for (const handler of COMMAND_HANDLERS) {
        const handled = await handler(cmdWord, cmdArg, env, chatId, fromId, messageId);
        if (handled) return new Response("OK", { status: 200 });
      }
    }

    // --- Canonical identity shortcut (skips the AI model entirely) ------
    const activeModelForId = await getActiveModel(env, chatId);
    const identityModelName = (activeModelForId || "").split(":")[0];
    const identityAnswer = canonicalIdentityAnswer(userText, identityModelName);
    if (identityAnswer) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, identityAnswer);
      return new Response("OK", { status: 200 });
    }

    // --- Free-text AI chat, with tool calling ----------------------------
    try {
      const apiConfig = await getActiveApi(env, chatId);
      if (!apiConfig) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Belum ada provider. Tambah dengan /addprovider\nContoh: /addprovider zen https://api.example.com/v1 sk-xxx model1,model2");
        return new Response("OK", { status: 200 });
      }
      const { base_url, api_key } = apiConfig;
      const activeModelForId2 = await getActiveModel(env, chatId);
      const AI_MODEL = (activeModelForId2 || "").split(":")[0] || "";
      const PROVIDER_ID = (activeModelForId2 || "").split(":")[1] || "";
      const EXTERNAL_API_URL = resolveApiEndpoint(base_url, AI_MODEL, PROVIDER_ID);

      let history = await getChatMemory(env, chatId);
      if (history.length >= MEMORY_MAX_ENTRIES) {
        const recent = history.slice(-20);
        const summary = await summarizeHistory(env, AI_MODEL, history.slice(0, -20));
        if (summary) {
          history = [...summary, ...recent];
          await saveChatMemory(env, chatId, history);
        } else {
          history = recent;
        }
      }

      // Load dynamic custom tools from D1
      const allTools = await getAllToolDefinitions(env, chatId);
      const cavemanMode = await getCavemanMode(env, chatId);

      const cavemanRules = cavemanMode ? `

CAVEMAN MODE: Kamu sedang dalam mode hemat token. Aturan:
- Drop artikel, preposisi, kata pengisi yang tidak perlu.
- Jangan potong kode, perintah, path file, atau pesan error.
- Peringatan keamanan dan konfirmasi tetap dalam kalimat lengkap.
- Contoh: "New object ref each render. Inline object prop = new ref = re-render. Wrap in useMemo."
- Contoh ID: "Tool X belum ada. Mau buatkan?"` : "";

      const systemPrompt = `Kamu adalah bot Telegram AI bernama "My Assist". Identitas: "aku adalah bot buatan Naufal Alamsyah menggunakan model ${AI_MODEL}". Jika ditanya identitas, jawab persis kalimat tersebut.

PENTING — GUNAKAN RIWAYAT CHAT: Pesan-pesan sebelum pesan terbaru adalah riwayat percakapan yang BISA kamu baca. Gunakan konteks itu saat menjawab. Jika user bertanya "tadi kita ngomong apa", "lanjutkan", "ingat?" atau merujuk obrolan sebelumnya, jawab berdasarkan riwayat yang tersedia, JANGAN mengaku tidak ingat selama konteksnya ada di riwayat.

GAYA JAWABAN: Jawab SEPENDEK-PENDEKNYA dan langsung ke inti. Untuk pertanyaan sederhana (ya/tidak, angka, fakta cepat, sapa, "halo"), jawab 1-2 kalimat tanpa basa-basi, tanpa pendahuluan, tanpa penutup. Jangan menjelaskan proses berpikirmu. Hanya perjelas bila diminta.

Kamu WAJIB menggunakan tool function calling saat dibutuhkan. Jangan menjawab dengan teks biasa jika ada tool yang bisa menjawab.
Tool custom_XXX adalah tool yang dibuat user. Panggil langsung dengan nama tool-nya (tanpa prefix custom_ jika sudah terdaftar di function calling).
Jika TIDAK ADA tool yang cocok untuk menjawab pertanyaan user, TAWARKAN untuk membuat skill baru: "Saya belum punya tool untuk ini. Mau saya buatkan skill baru?" Jika user setuju, gunakan tool create_skill dengan parameter yang sesuai.

Tool tersedia:
- websearch(query): cari informasi terkini dari web. Panggil saat user bertanya berita / fakta / info.
- get_current_time(): cek waktu sekarang. Panggil saat user tanya jam / tanggal / hari.
- list_projects(): lihat daftar project user di D1.
- storage_status(): cek status storage D1.
- cleanup_recommendations(): rekomendasi hapus project (FILO).
- list_models(): daftar model AI yang tersedia.
- switch_model(model): ganti model AI sesi ini.
- create_skill(tool_name, description, url_template, parameters, method): buat skill baru. method: GET/POST/PUT/DELETE. url_template: URL dengan {param} placeholder.
- list_skills(): lihat semua skill custom.

PENTING TOOL: Jika sudah punya jawaban dari tool sebelumnya, JANGAN panggil tool yang sama lagi. Langsung jawab. Jika tool gagal/error, jangan ulang — langsung jawab dengan info yang tersedia. Maksimal 3-4 tool calls per pesan.
- delete_skill(tool_name): hapus skill custom.
- newproject(name, template): buat project baru + repo GitHub. Konfirmasi dulu ke user.
- purge_project(name): hapus project dari D1 (repo GitHub tetap ada). Konfirmasi dulu ke user.
- commit_files(repo, message, files): commit file ke GitHub. Gunakan saat user kirim kode.
- list_repo_files(repo, path): lihat daftar file di repo GitHub.
- read_repo_file(repo, path): baca isi file dari GitHub.
- delete_repo(repo): hapus repo GitHub permanen. Konfirmasi dulu ke user.
- list_github_repos(): lihat semua repo GitHub milikmu.
- change_repo_visibility(repo, private): ubah visibilitas repo (public/private). Konfirmasi dulu.
- create_repo_branch(repo, branch): buat branch baru dari main/sumber lain.
- delete_repo_file(repo, path): hapus file dari repo via commit. Konfirmasi dulu.
- generate_file(name, content): buat file teks (md/txt/js/py/html/css/json) dan kirim ke user.
- generate_pdf(title, content, filename): buat dokumen HTML dengan tombol download PDF. Panggil saat user minta essay, artikel, laporan, dokumen PDF.

KETIKA USER MINTA PDF/ESSAY/ARTIKEL/LAPORAN: Gunakan generate_pdf. Isi content dalam format markdown, nanti otomatis dikonversi ke HTML yang rapi dengan tombol download.

Untuk setiap pesan user, periksa apakah ada tool yang relevan. Jangan menjawab dengan teks biasa jika tool tersedia.`;

      const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: userText }];

      let finalContent = "";
      let iterations = 0;
      const toolCallHistory = [];
      const loopStartTime = Date.now();
      const MAX_LOOP_TIME_MS = 60000;

      // Periodic typing indicator — refresh every 4 seconds, auto-expires
      const typingInterval = setInterval(() => {
        sendChatAction(env.TELEGRAM_TOKEN, chatId);
      }, 4000);
      sendChatAction(env.TELEGRAM_TOKEN, chatId);

      try {
      while (iterations < MAX_TOOL_ITERATIONS) {
        // Check if /stop was called
        if (chatCancelled.get(chatId)) {
          finalContent = "Proses dihentikan oleh user.";
          break;
        }
        if (Date.now() - loopStartTime > MAX_LOOP_TIME_MS) {
          finalContent = "Waktu pemrosesan habis. Coba jelaskan lebih singkat.";
          break;
        }
        const controller = new AbortController();
        const aiTimeout = setTimeout(() => controller.abort(), 60000);
        let externalRes;
        try {
          externalRes = await fetch(EXTERNAL_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${api_key}` },
            body: JSON.stringify({ model: AI_MODEL, messages, tools: allTools, max_tokens: 4096 }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(aiTimeout);
        }

        if (!externalRes.ok) {
          const errBody = await externalRes.json().catch(() => ({}));
          const errMsg = errBody?.error?.message || errBody?.message || `HTTP ${externalRes.status}`;
          throw new Error(`AI API error: ${errMsg}`);
        }
        const aiData = await externalRes.json();
        let finalMsg = null;
        const choice = aiData.choices?.[0];
        if (choice?.message) {
          finalMsg = choice.message;
          if (!finalMsg.content && finalMsg.reasoning_content) {
            finalMsg = { content: finalMsg.reasoning_content };
          }
        } else if (aiData.content?.[0]?.text) {
          finalMsg = { content: aiData.content[0].text };
        }
        if (!finalMsg) {
          const resp = aiData?.error?.message || JSON.stringify(aiData).slice(0, 500);
          console.error("[AI] unrecognized response:", resp);
          throw new Error(`AI response empty. Detail: ${resp}`);
        }

        if (finalMsg.tool_calls?.length > 0) {
          messages.push(finalMsg);
          for (const tc of finalMsg.tool_calls) {
            // Check /stop between tool calls
            if (chatCancelled.get(chatId)) {
              finalContent = "Proses dihentikan oleh user.";
              break;
            }
            const result = await executeTool(tc, env, chatId, fromId);
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
            const callKey = `${tc.function?.name}:${tc.function?.arguments}`;
            toolCallHistory.push(callKey);
            const sameCount = toolCallHistory.filter((k) => k === callKey).length;
            if (sameCount >= 3) {
              finalContent = "Saya sepertinya stuck memanggil tool yang sama. Berikut jawaban berdasarkan apa yang sudah saya dapat:\n\n" + (finalMsg.content || "Coba jelaskan dengan lebih spesifik agar saya bisa bantu.");
              break;
            }
          }
          if (finalContent) break;
          iterations++;
          continue;
        }

        finalContent = finalMsg.content || "Maaf, tidak ada respons.";
        break;
      }
      if (!finalContent) finalContent = "Terlalu banyak langkah tool. Coba jelaskan lebih singkat atau spesifik.";
      } finally {
        clearInterval(typingInterval);
      }

      await sendTelegram(env.TELEGRAM_TOKEN, chatId, String(finalContent).trim().slice(0, 4096));
      history = [...history, { role: "user", content: userText }, { role: "assistant", content: String(finalContent).trim() }];
      await saveChatMemory(env, chatId, history);
    } catch (err) {
      console.error(err);
      try {
        const errMsg = err.message || "Unknown error";
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Error: ${errMsg.slice(0, 500)}`);
      } catch {
        // best effort
      }
    }

    return new Response("OK", { status: 200 });
    }); // end enqueueChatTask
  }
};
