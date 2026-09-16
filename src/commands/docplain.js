// src/commands/docplain.js
// /docplain — extract PDF text to .md file (pure CPU, no AI)

import { sendTelegram, sendTelegramDocument, sendChatAction } from "../telegram.js";
import { extractPdfText } from "../documents.js";

export async function handleDocplainCommand(cmdWord, cmdArg, env, chatId, fromId, messageId, docInfo) {
  if (cmdWord !== "/docplain") return false;

  if (!docInfo || !/\.pdf$/i.test(docInfo.file_name || "")) {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Kirim PDF sebagai lampiran bersama /docplain");
    return true;
  }

  await sendChatAction(env.TELEGRAM_TOKEN, chatId);

  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: docInfo.file_id })
  });
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  if (!filePath) {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengambil file.");
    return true;
  }

  const dl = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  if (!dl.ok) {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengunduh file.");
    return true;
  }

  const buf = await dl.arrayBuffer();
  const bytes = new Uint8Array(buf);

  try {
    const text = await extractPdfText(bytes);

    if (!text || text.trim().length === 0) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Tidak ada teks yang bisa diekstrak dari PDF ini.");
      return true;
    }

    const fileName = docInfo.file_name || "document.pdf";
    const mdContent = `# ${fileName}\n\n${text.trim()}`;
    const mdFileName = fileName.replace(/\.pdf$/i, ".md");

    await sendTelegramDocument(env.TELEGRAM_TOKEN, chatId, mdFileName, mdContent);
  } catch (err) {
    console.error("[DOCPlain] Error:", err.message);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengekstrak teks: " + err.message);
  }

  return true;
}
