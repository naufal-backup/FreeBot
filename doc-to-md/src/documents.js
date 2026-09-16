// doc-to-md/src/documents.js
// Document text extraction: PDF, DOCX, HTML, TXT, MD, images.
// Includes OCR fallback and CMap-based PDF support.

// ── Utilities ───────────────────────────────────────────────────────────────

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

function parseCMap(text) {
  const cmap = new Map();
  let section = null;
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.includes("beginbfchar")) { section = "char"; continue; }
    if (line.includes("endbfchar")) { section = null; continue; }
    if (line.includes("beginbfrange")) { section = "range"; continue; }
    if (line.includes("endbfrange")) { section = null; continue; }

    if (section === "char") {
      const chM = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
      if (chM) {
        cmap.set(parseInt(chM[1], 16), String.fromCodePoint(parseInt(chM[2], 16)));
      }
    }

    if (section === "range") {
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
  const streamMarker = new Uint8Array([115, 116, 114, 97, 101, 109]);

  let pos = 0;
  while (pos < data.length) {
    const streamIdx = findBytes(data, streamMarker, pos);
    if (streamIdx === -1) break;

    const dictStart = Math.max(0, streamIdx - 3000);
    const dictSlice = decoder.decode(data.slice(dictStart, streamIdx));

    // Check for /Length in dictionary
    const lengthMatch = dictSlice.match(/\/Length\s+(\d+)/);
    if (!lengthMatch) { pos = streamIdx + 6; continue; }

    const isFlate = dictSlice.includes("FlateDecode");
    if (!isFlate) { pos = streamIdx + 6; continue; }

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

// ── Hex → Unicode with CMap ─────────────────────────────────────────────────

function hexToUnicode(hex, cmap) {
  const results = [];

  if (cmap && cmap.size > 0) {
    if (hex.length % 4 === 0) {
      for (let i = 0; i < hex.length; i += 4) {
        const code = parseInt(hex.slice(i, i + 4), 16);
        results.push(cmap.get(code) || String.fromCodePoint(code));
      }
    } else {
      for (let i = 0; i < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        results.push(cmap.get(code) || String.fromCodePoint(code));
      }
    }
  } else {
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

  // TJ array (catches [<hex> <hex>] TJ and [(text)] TJ)
  const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrRe.exec(raw)) !== null) {
    const inner = m[1].match(/\(([^)]*)\)/g);
    if (inner) for (const i of inner) results.push(i.slice(1, -1));
    const innerHex = m[1].match(/<([0-9A-Fa-f]+)>/g);
    if (innerHex) for (const i of innerHex) results.push(hexToUnicode(i.slice(1, -1), cmap));
  }

  // Hex strings before Tj
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

// ── PDF extraction ──────────────────────────────────────────────────────────

export async function extractPdfText(data) {
  const decoder = new TextDecoder("utf-8");

  // Step 0: extract CMap
  const cmap = await extractCMapsFromPdf(data);

  // Step 1: find streams, decompress using /Length, extract text
  const streamMarker = new Uint8Array([115, 116, 114, 101, 97, 109]);

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

  return allResults.join("\n").trim() || "";
}

function isPdfImageBased(data) {
  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(data);
  const hasImage = /\/Subtype\s*\/Image/.test(raw);
  const hasDCTDecode = /\/Filter\s*\/DCTDecode/.test(raw);
  const hasJPXDecode = /\/Filter\s*\/JPXDecode/.test(raw);
  return hasImage || hasDCTDecode || hasJPXDecode;
}

// ── DOCX extraction ─────────────────────────────────────────────────────────

export function extractDocxText(data) {
  try {
    const view = new DataView(data.buffer || data);
    let offset = 0;
    const files = {};
    while (offset + 30 < data.length) {
      if (view.getUint32(offset, true) !== 0x04034b50) { offset++; continue; }
      const compressedSize = view.getUint32(offset + 18, true);
      const fileNameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameOff = offset + 30;
      const name = new TextDecoder().decode(data.slice(nameOff, nameOff + fileNameLen));
      const dataOff = nameOff + fileNameLen + extraLen;
      files[name] = data.slice(dataOff, dataOff + compressedSize);
      offset = dataOff + compressedSize;
    }

    const docXml = files["word/document.xml"] || Object.values(files).find((v, k) => k.includes("document.xml"));
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

// ── HTML extraction ─────────────────────────────────────────────────────────

export function extractHtmlText(data) {
  try {
    let html = new TextDecoder("utf-8", { fatal: false }).decode(data);

    // Remove script, style, head
    html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<head[\s\S]*?<\/head>/gi, "");

    // Convert block elements to newlines
    html = html.replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n");
    html = html.replace(/<br\s*\/?>/gi, "\n");

    // Remove all remaining HTML tags
    html = html.replace(/<[^>]+>/g, " ");

    // Decode HTML entities
    html = html
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    html = html.replace(/[ \t]+/g, " ");
    html = html.replace(/\n\s*\n/g, "\n\n");

    return html.trim();
  } catch (err) {
    return `(Gagal baca HTML: ${err.message})`;
  }
}

// ── Plain text ──────────────────────────────────────────────────────────────

export function extractPlainText(data) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(data).trim();
  } catch (err) {
    return `(Gagal baca teks: ${err.message})`;
  }
}

// ── Image MIME detection ────────────────────────────────────────────────────

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

// ── OCR via Cloudflare Workers AI ───────────────────────────────────────────

async function ocrDocument(env, bytes, mimeType, fileName) {
  try {
    const input = { image: [...bytes.slice(0, 1048576)] };
    const response = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: input.image },
            { type: "text", text: "Extract ALL text from this document image. Output ONLY the text content, preserving original formatting and structure (headings, paragraphs, lists, tables). Do NOT add any commentary or descriptions." }
          ]
        }
      ],
      max_tokens: 4096
    });
    return response?.response || "";
  } catch (err) {
    console.error("OCR failed:", err.message);
    return "";
  }
}

// ── Main extraction function ────────────────────────────────────────────────

export async function extractDocumentText(env, bytes, fileName, mimeHint) {
  const nm = (fileName || "").toLowerCase();
  const hint = (mimeHint || "").toLowerCase();

  const isPdf = /\.pdf$/.test(nm) || hint.includes("pdf");
  const isDocx = /\.docx$/.test(nm) || hint.includes("wordprocessing") || hint.includes("officedocument");
  const isHtml = /\.html?$/.test(nm) || hint.includes("html");
  const isMd = /\.md$/.test(nm) || hint.includes("markdown");
  const isTxt = /\.txt$/.test(nm) || hint.includes("text/plain") || hint === "text";
  const isImage = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(nm) || hint.startsWith("image/");

  const sig = String.fromCharCode(...bytes.slice(0, 4));

  // PDF with OCR fallback
  if (sig.startsWith("%PDF") || (isPdf && !isDocx)) {
    let text = await extractPdfText(bytes);
    if (!text || text.length < 50 || isPdfImageBased(bytes)) {
      const ocrText = await ocrDocument(env, bytes, "application/pdf", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
    }
    return text || "(Teks tidak dapat diekstrak. PDF mungkin hasil scan.)";
  }

  // DOCX with OCR fallback
  if (sig.startsWith("PK") && (isDocx || !isPdf)) {
    let text = extractDocxText(bytes);
    if (!text || text.length < 30) {
      const ocrText = await ocrDocument(env, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName);
      if (ocrText && ocrText.length > text.length) return ocrText;
    }
    return text || "(Teks kosong atau DOCX berisi gambar)";
  }

  // Images → always OCR
  if (isImage || detectImageMime(bytes)) {
    const imgMime = detectImageMime(bytes) || "image/png";
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
