// src/documents.js
// Text extraction for PDF, DOCX, HTML, TXT, MD, and image files.
// Includes OCR fallback for scanned documents and images.
// Supports FlateDecode compressed PDF streams and CMap-based encoding.

import { ocrDocument } from "./ocr.js";

function findBytes(data, needle, start = 0) {
  for (let i = start; i <= data.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (data[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

async function decompressFlate(data) {
  for (const mode of ["deflate", "raw"]) {
    try {
      const ds = new DecompressionStream(mode);
      const writer = ds.writable.getWriter();
      writer.write(data);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    } catch { /* try next mode */ }
  }
  return null;
}

// ── CMap support ────────────────────────────────────────────────────────────
// CMap maps character codes (hex in PDF streams) to Unicode code points.
// Common in CIDFont-based PDFs (CJK, modern fonts).

function parseCMap(text) {
  const cmap = new Map();

  // beginbfchar: <srcHex> <dstHex>
  // e.g. <0041> <0041> means code 0x0041 → U+0041 (A)
  const bfCharRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  let section = null;
  let m;

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.includes("beginbfchar")) { section = "char"; continue; }
    if (line.includes("endbfchar")) { section = null; continue; }
    if (line.includes("beginbfrange")) { section = "range"; continue; }
    if (line.includes("endbfrange")) { section = null; continue; }

    if (section === "char") {
      const chM = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (chM) {
        const src = parseInt(chM[1], 16);
        const dst = parseInt(chM[2], 16);
        cmap.set(src, String.fromCodePoint(dst));
      }
    }

    if (section === "range") {
      // Format: <startCode> <endCode> <startUnicode>
      // e.g. <0041> <005A> <0041> → codes 0x41-0x5A map to U+0041-U+005A (A-Z)
      const rangeM = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (rangeM) {
        const startCode = parseInt(rangeM[1], 16);
        const endCode = parseInt(rangeM[2], 16);
        let startUnicode = parseInt(rangeM[3], 16);
        for (let code = startCode; code <= endCode && code - startCode < 5000; code++) {
          cmap.set(code, String.fromCodePoint(startUnicode));
          startUnicode++;
        }
      }
    }
  }

  return cmap;
}

async function extractCMapsFromPdf(data) {
  const decoder = new TextDecoder("utf-8");
  const merged = new Map();
  const streamMarker = new Uint8Array([115, 116, 114, 97, 101, 109]); // "stream"

  let pos = 0;
  while (pos < data.length) {
    const streamIdx = findBytes(data, streamMarker, pos);
    if (streamIdx === -1) break;

    const dictStart = Math.max(0, streamIdx - 3000);
    const dictSlice = decoder.decode(data.slice(dictStart, streamIdx));

    const lengthMatch = dictSlice.match(/\/Length\s+(\d+)/);
    if (!lengthMatch) { pos = streamIdx + 6; continue; }
    if (!dictSlice.includes("FlateDecode")) { pos = streamIdx + 6; continue; }

    let dataStart = streamIdx + 6;
    if (data[dataStart] === 13) dataStart++;
    if (data[dataStart] === 10) dataStart++;

    const streamLen = parseInt(lengthMatch[1]);
    const streamBytes = data.slice(dataStart, dataStart + streamLen);

    const decompressed = await decompressFlate(streamBytes);
    if (decompressed) {
      const streamText = decoder.decode(decompressed);
      if (streamText.includes("beginbfchar") || streamText.includes("beginbfrange")) {
        const cmap = parseCMap(streamText);
        for (const [k, v] of cmap) merged.set(k, v);
      }
    }

    pos = dataStart + streamLen;
  }

  return merged;
}

// ── Hex → Unicode with CMap support ─────────────────────────────────────────

function hexToUnicode(hex, cmap) {
  // Convert hex string to unicode text using CMap if available.
  // PDF hex: pairs of 2 hex digits per byte. Common patterns:
  //   4 hex digits (2 bytes) → character code
  //   2 hex digits (1 byte)  → character code (single-byte font)

  const results = [];
  // PDF hex strings are pairs of hex digits: "0041" = code 0x0041
  // They can be 2-digit (1 byte), 4-digit (2 bytes), or 6-digit (3 bytes)
  const chunkSize = hex.length <= 4 ? 2 : 4; // auto-detect byte width

  if (cmap && cmap.size > 0) {
    // Use CMap: treat entire hex string as a sequence of character codes
    // Try 4-digit chunks first (2-byte CID fonts)
    if (hex.length % 4 === 0) {
      for (let i = 0; i < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        results.push(cmap.get(code) || String.fromCodePoint(code));
      }
    } else {
      // Fallback: try 2-digit chunks (1-byte fonts)
      for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        results.push(cmap.get(code) || String.fromCodePoint(code));
      }
    }
  } else {
    // No CMap — direct code point mapping
    if (hex.length % 4 === 0) {
      for (let i = 0; i < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        if (code > 0) results.push(String.fromCodePoint(code));
      }
    } else {
      for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        if (code > 0) results.push(String.fromCodePoint(code));
      }
    }
  }

  return results.join("");
}

function extractTextFromRaw(raw, cmap) {
  const results = [];
  let m;

  // Parenthesized strings: (text) Tj
  const tjRe = /\(([^)]*)\)\s*Tj/g;
  while ((m = tjRe.exec(raw)) !== null) results.push(m[1]);

  // TJ array first (catches [<hex> <hex>] TJ and [(text)] TJ)
  const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(raw)) !== null) {
    const inner = m[1].match(/\(([^)]*)\)/g);
    if (inner) for (const i of inner) results.push(i.slice(1, -1));
    const innerHex = m[1].match(/<([0-9A-Fa-f]+)>/g);
    if (innerHex) for (const i of innerHex) results.push(hexToUnicode(i.slice(1, -1), cmap));
  }

  // Hex strings before Tj (not inside TJ array): capture all <hex> blocks before Tj
  const tjBlockRe = /(?:^|\s)((?:<[0-9A-Fa-f]+>\s*)+)\s*Tj/g;
  while ((m = tjBlockRe.exec(raw)) !== null) {
    const hexes = m[1].match(/<([0-9A-Fa-f]+)>/g);
    if (hexes) for (const h of hexes) results.push(hexToUnicode(h.slice(1, -1), cmap));
  }

  // BT...ET blocks fallback
  if (results.length === 0) {
    const btRe = /BT\s*([\s\S]*?)\s*ET/g;
    while ((m = btRe.exec(raw)) !== null) {
      const block = m[1];
      const pRe = /\(([^)]*)\)/g;
      let pm;
      while ((pm = pRe.exec(block)) !== null) results.push(pm[1]);
      const hRe = /<([0-9A-Fa-f]+)>/g;
      let hm;
      while ((hm = hRe.exec(block)) !== null) {
        if (hm[1].length >= 4) results.push(hexToUnicode(hm[1], cmap));
      }
    }
  }

  return results.join(" ").trim();
}

export async function extractPdfText(data) {
  const decoder = new TextDecoder("utf-8");

  // Step 0: extract CMap
  const cmap = await extractCMapsFromPdf(data);

  // Step 1: find streams, decompress using /Length, extract text
  const streamMarker = new Uint8Array([115, 116, 114, 101, 97, 109]); // "stream"

  let pos = 0;
  const allResults = [];

  while (pos < data.length) {
    const streamIdx = findBytes(data, streamMarker, pos);
    if (streamIdx === -1) break;

    const dictSearchStart = Math.max(0, streamIdx - 3000);
    const dictSlice = decoder.decode(data.slice(dictSearchStart, streamIdx));

    // Use /Length from dictionary, not endstream position
    const lengthMatch = dictSlice.match(/\/Length\s+(\d+)/);
    if (!lengthMatch) { pos = streamIdx + 6; continue; }

    let dataStart = streamIdx + 6;
    if (data[dataStart] === 13) dataStart++;
    if (data[dataStart] === 10) dataStart++;

    const streamLen = parseInt(lengthMatch[1]);
    const streamBytes = data.slice(dataStart, dataStart + streamLen);

    if (dictSlice.includes("FlateDecode")) {
      const decompressed = await decompressFlate(streamBytes);

      if (decompressed) {
        const decompRaw = decoder.decode(decompressed);

        if (decompRaw.includes("BT") && decompRaw.includes("ET")) {
          const decompText = extractTextFromRaw(decompRaw, cmap);
          if (decompText && decompText.length > 10) allResults.push(decompText);
        }

        // BT...ET blocks
        const btRe = /BT\s*([\s\S]*?)\s*ET/g;
        let bm;
        while ((bm = btRe.exec(decompRaw)) !== null) {
          const lines = bm[1].match(/\(([^)]*)\)/g);
          if (lines) {
            const btText = lines.map(l => l.slice(1, -1)).join(" ").trim();
            if (btText && btText.length > 5) allResults.push(btText);
          }
          const hexRe = /<([0-9A-Fa-f]+)>/g;
          let hm;
          while ((hm = hexRe.exec(bm[1])) !== null) {
            if (hm[1].length >= 4) allResults.push(hexToUnicode(hm[1], cmap));
          }
        }
      }
    } else if (!dictSlice.includes("DCTDecode") && !dictSlice.includes("JPXDecode")) {
      const rawText = decoder.decode(streamBytes);
      if (rawText.includes("BT") && rawText.includes("ET")) {
        const text = extractTextFromRaw(rawText, cmap);
        if (text && text.length > 10) allResults.push(text);
      }
    }

    pos = dataStart + streamLen;
  }

  const combined = allResults.join("\n").trim();
  return combined || "";
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
  // Download file from Telegram
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

  // Try doc-to-md worker via service binding first
  if (env.DOC_TO_MD) {
    try {
      // Convert to base64
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      console.log("[DOC_TO_MD] Calling worker, file:", fileName, "size:", bytes.length);
      const resp = await env.DOC_TO_MD.fetch(new Request("https://doc-to-md.internal/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file_name: fileName,
          mime_type: mimeHint || "",
          file_bytes: base64
        })
      }));

      const result = await resp.json();
      console.log("[DOC_TO_MD] Result:", result.text?.length || 0, "chars, error:", result.error);
      if (result.text) return result.text;
      if (result.error) throw new Error(result.error);
    } catch (err) {
      console.error("[DOC_TO_MD] Worker failed, falling back to local:", err.message);
    }
  }

  // Local fallback: extract directly
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
    let text = await extractPdfText(bytes);
    if (!text || text.length < 50 || isPdfImageBased(bytes)) {
      const ocrText = await ocrDocument(env, bytes, "application/pdf", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
    }
    return text || "(Teks tidak dapat diekstrak. PDF mungkin hasil scan.)";
  }

  if (sig.startsWith("PK") && (isDocx || !isPdf)) {
    let text = extractDocxText(bytes);
    if (!text || text.length < 30) {
      const ocrText = await ocrDocument(env, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
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
