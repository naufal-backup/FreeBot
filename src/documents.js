// src/documents.js
// Text extraction for PDF, DOCX, HTML, TXT, MD, and image files.
// Uses unpdf (Mozilla PDF.js) for PDF, OCR fallback for scanned/image docs.

import { ocrDocument } from "./ocr.js";
import { extractText, getDocumentProxy } from "unpdf";

function isGarbledText(text) {
  if (!text || text.length < 50) return true;
  const words = text.split(/\s+/);
  if (words.length < 10) return false;
  const singleAlpha = words.filter(w => w.length === 1 && /[a-zA-Z]/.test(w)).length;
  return singleAlpha / words.length > 0.3;
}

export async function extractPdfText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return (text || "").trim();
}

function extractHtmlText(data) {
  try {
    let html = new TextDecoder("utf-8", { fatal: false }).decode(data);
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<head[\s\S]*?<\/head>/gi, "");
    html = html.replace(/<(br|hr)\s*\/?>/gi, "\n");
    html = html.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
    html = html.replace(/<li[\s\S]*?<\/li>/gi, (m) => "- " + m.replace(/<[^>]+>/g, "").trim() + "\n");
    html = html.replace(/<[^>]+>/g, "");
    html = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    html = html.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n");
    return html.trim();
  } catch (err) {
    return `(Gagal baca HTML: ${err.message})`;
  }
}

function extractPlainText(data) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(data).trim();
  } catch (err) {
    return `(Gagal baca teks: ${err.message})`;
  }
}

function detectImageMime(bytes) {
  const sig = String.fromCharCode(...bytes.slice(0, 4));
  if (sig.startsWith("\x89PNG")) return "image/png";
  if (sig.startsWith("\xFF\xD8\xFF")) return "image/jpeg";
  if (sig.startsWith("RIFF") && bytes.length > 12) {
    const webp = String.fromCharCode(...bytes.slice(8, 12));
    if (webp === "WEBP") return "image/webp";
  }
  if (sig.startsWith("GIF8")) return "image/gif";
  return null;
}

export async function extractDocumentText(env, fileId, fileName, mimeHint, signal) {
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  if (!filePath) throw new Error("File tidak ditemukan di Telegram.");

  const dl = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`, { signal });
  if (!dl.ok) throw new Error("Gagal download file.");

  const buf = await dl.arrayBuffer();
  const bytes = new Uint8Array(buf);

  console.log("[DOC] Downloaded:", fileName, bytes.length, "bytes, hint:", mimeHint);
  return localExtract(bytes, fileName, mimeHint, env);
}

async function localExtract(bytes, fileName, mimeHint, env) {
  const nm = (fileName || "").toLowerCase();
  const hint = (mimeHint || "").toLowerCase();

  const isPdf = /\.pdf$/.test(nm) || hint.includes("pdf");
  const isDocx = /\.docx$/.test(nm) || hint.includes("wordprocessing") || hint.includes("officedocument");
  const isHtml = /\.html?$/.test(nm) || hint.includes("html");
  const isMd = /\.md$/.test(nm) || hint.includes("markdown");
  const isTxt = /\.txt$/.test(nm) || hint.includes("text/plain") || hint === "text";
  const isImage = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(nm) || hint.startsWith("image/");

  const sig = String.fromCharCode(...bytes.slice(0, 4));

  if (sig.startsWith("%PDF") || (isPdf && !isDocx)) {
    console.log("[LOCAL] PDF via unpdf...");
    let text = await extractPdfText(bytes);
    const garbled = isGarbledText(text);
    console.log("[LOCAL] PDF:", text.length, "chars, garbled:", garbled);
    if (!text || text.length < 50 || garbled) {
      console.log("[LOCAL] OCR fallback...");
      const ocrText = await ocrDocument(env, bytes, "application/pdf", fileName);
      if (ocrText && ocrText.length > 20) return ocrText;
    }
    return text || "(Teks tidak dapat diekstrak. PDF mungkin hasil scan.)";
  }

  if (sig.startsWith("PK") && (isDocx || !isPdf)) {
    console.log("[LOCAL] DOCX via regex...");
    let text = extractDocxText(bytes);
    if (!text || text.length < 30) {
      const ocrText = await ocrDocument(env, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName);
      if (ocrText && ocrText.length > 20) return ocrText;
    }
    return text || "(Teks kosong atau DOCX berisi gambar)";
  }

  if (isImage || detectImageMime(bytes)) {
    const imgMime = detectImageMime(bytes) || "image/png";
    const ocrText = await ocrDocument(env, bytes, imgMime, fileName);
    return ocrText || "(Tidak dapat membaca teks dari gambar.)";
  }

  if (isHtml || sig.startsWith("<!D") || sig.startsWith("<htm")) {
    return extractHtmlText(bytes) || "(HTML kosong atau tidak memiliki teks.)";
  }

  if (isMd || isTxt) {
    return extractPlainText(bytes) || "(File kosong.)";
  }

  const fallback = extractPlainText(bytes);
  if (fallback && fallback.length > 10) return fallback;

  throw new Error("Format tidak didukung. Kirim PDF, DOCX, HTML, TXT, MD, atau gambar.");
}

function extractDocxText(data) {
  try {
    const view = new DataView(data.buffer || data);
    let offset = 0;
    const files = {};
    while (offset + 30 < data.length) {
      if (view.getUint32(offset, true) !== 0x04034b50) {
        offset++;
        continue;
      }
      const compressedSize = view.getUint32(offset + 18, true);
      const fileNameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameOff = offset + 30;
      const name = new TextDecoder().decode(data.slice(nameOff, nameOff + fileNameLen));
      const dataOff = nameOff + fileNameLen + extraLen;
      const compData = data.slice(dataOff, dataOff + compressedSize);
      files[name] = compData;
      offset = dataOff + compressedSize;
    }

    const docXml =
      files["word/document.xml"] ||
      files["word/document2.xml"] ||
      Object.values(files).find((v, k) => k.includes("document.xml"));
    if (!docXml) return "(Tidak ditemukan word/document.xml dalam DOCX.)";

    const xml = new TextDecoder("utf-8", { fatal: false }).decode(docXml);
    const texts = [];
    let m;
    const wtRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    while ((m = wtRe.exec(xml)) !== null) {
      texts.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    }
    return texts.join("\n").trim() || "";
  } catch (err) {
    return `(Gagal baca DOCX: ${err.message})`;
  }
}
