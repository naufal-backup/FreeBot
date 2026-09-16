// src/documents.js
// Text extraction for PDF, DOCX, HTML, TXT, MD, and image files.
// Includes OCR fallback for scanned documents and images.

import { ocrDocument } from "./ocr.js";

export function extractPdfText(data) {
  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(data);
  raw.replace(/\/[A-Za-z]+\s*<<[\s\S]*?>>/g, "").replace(/\/Filter\s*\/[A-Za-z0-9]+/g, "");

  const results = [];
  let m;

  const tjRe = /\(([^)]*)\)\s*Tj/g;
  while ((m = tjRe.exec(raw)) !== null) results.push(m[1]);

  const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(raw)) !== null) {
    const inner = m[1].match(/\(([^)]*)\)/g);
    if (inner) for (const i of inner) results.push(i.slice(1, -1));
  }

  const text = results.join(" ").trim();
  if (text) return text;

  const btRe = /BT\s*([\s\S]*?)\s*ET/g;
  const btResults = [];
  while ((m = btRe.exec(raw)) !== null) {
    const lines = m[1].match(/\(([^)]*)\)/g);
    if (lines) for (const l of lines) btResults.push(l.slice(1, -1));
  }

  return btResults.join(" ").trim() || "";
}

function isPdfImageBased(data) {
  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(data);
  const hasImage = /\/Subtype\s*\/Image/.test(raw);
  const hasXObject = /\/XObject/.test(raw);
  const hasDCTDecode = /\/Filter\s*\/DCTDecode/.test(raw);
  const hasFlateWithImage = /\/Filter\s*\/FlateDecode/.test(raw) && hasImage;
  return hasImage || hasXObject || hasDCTDecode || hasFlateWithImage;
}

export function extractDocxText(data) {
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

/**
 * Extract text from HTML by stripping tags and decoding entities.
 */
export function extractHtmlText(data) {
  try {
    let html = new TextDecoder("utf-8", { fatal: false }).decode(data);

    // Remove script and style blocks
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<head[\s\S]*?<\/head>/gi, "");

    // Convert block elements to newlines
    html = html.replace(/<(br|hr)\s*\/?>/gi, "\n");
    html = html.replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, "\n");
    html = html.replace(/<li[\s\S]*?<\/li>/gi, (m) => "- " + m.replace(/<[^>]+>/g, "").trim() + "\n");

    // Remove all remaining HTML tags
    html = html.replace(/<[^>]+>/g, "");

    // Decode common HTML entities
    html = html
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    // Collapse whitespace
    html = html.replace(/[ \t]+/g, " ");
    html = html.replace(/\n\s*\n/g, "\n\n");

    return html.trim();
  } catch (err) {
    return `(Gagal baca HTML: ${err.message})`;
  }
}

/**
 * Extract text from plain text / markdown (just decode).
 */
export function extractPlainText(data) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(data).trim();
  } catch (err) {
    return `(Gagal baca teks: ${err.message})`;
  }
}

/**
 * Detect image MIME type from file signature.
 */
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

export async function extractDocumentText(env, fileId, fileName, mimeHint) {
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  if (!filePath) throw new Error("File tidak ditemukan di Telegram.");

  const dl = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  if (!dl.ok) throw new Error("Gagal download file.");

  const buf = await dl.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const nm = (fileName || "").toLowerCase();
  const hint = (mimeHint || "").toLowerCase();

  // Detect format from extension + MIME
  const isPdf = /\.pdf$/.test(nm) || hint.includes("pdf");
  const isDocx = /\.docx$/.test(nm) || hint.includes("wordprocessing") || hint.includes("officedocument");
  const isHtml = /\.html?$/.test(nm) || hint.includes("html");
  const isMd = /\.md$/.test(nm) || hint.includes("markdown");
  const isTxt = /\.txt$/.test(nm) || hint.includes("text/plain") || hint === "text";
  const isImage = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(nm) || hint.startsWith("image/");

  const sig = String.fromCharCode(...bytes.slice(0, 4));

  // PDF with OCR fallback
  if (sig.startsWith("%PDF") || (isPdf && !isDocx)) {
    let text = extractPdfText(bytes);
    if (!text || text.length < 50 || isPdfImageBased(bytes)) {
      console.log("PDF scan detected, attempting OCR...");
      const ocrText = await ocrDocument(env, bytes, "application/pdf", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
    }
    return text || "(Teks tidak dapat diekstrak. PDF mungkin hasil scan.)";
  }

  // DOCX with OCR fallback
  if (sig.startsWith("PK") && (isDocx || !isPdf)) {
    let text = extractDocxText(bytes);
    if (!text || text.length < 30) {
      console.log("DOCX minimal text, attempting OCR...");
      const ocrText = await ocrDocument(env, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
    }
    return text || "(Teks kosong atau DOCX berisi gambar)";
  }

  // Images → OCR
  if (isImage || detectImageMime(bytes)) {
    const imgMime = detectImageMime(bytes) || "image/png";
    console.log("Image detected, attempting OCR...");
    const ocrText = await ocrDocument(env, bytes, imgMime, fileName);
    return ocrText || "(Tidak dapat membaca teks dari gambar.)";
  }

  // HTML
  if (isHtml || sig.startsWith("<!D") || sig.startsWith("<htm")) {
    return extractHtmlText(bytes) || "(HTML kosong atau tidak memiliki teks.)";
  }

  // Markdown / Plain text
  if (isMd || isTxt) {
    return extractPlainText(bytes) || "(File kosong.)";
  }

  // Fallback: try as text
  const fallback = extractPlainText(bytes);
  if (fallback && fallback.length > 10) return fallback;

  throw new Error("Format tidak didukung. Kirim PDF, DOCX, HTML, TXT, MD, atau gambar.");
}
