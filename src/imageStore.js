// src/imageStore.js
// Transient storage for user-uploaded images in D1. Flow: user sends a photo
// -> we download it from Telegram -> store base64 in `user_images` (metadata)
// + `user_image_chunks` (payload, split to respect D1's ~1MB bound-parameter
// limit). Tools (poster/pdf/github) read the image by id, use it, then delete
// it so D1 does not fill up. A cron sweep removes anything past `expires_at`.

import { IMAGE_TTL_MS, IMAGE_MAX_BYTES } from "./config.js";

// D1 rejects bound params over ~1MB; keep each chunk's base64 well under that.
const CHUNK_B64_CHARS = 700_000; // ~525KB of binary per row

// Chunked ArrayBuffer -> base64. The naive per-byte string concat blows up
// memory/time on multi-MB images, so encode in 32k slices.
export function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function sniffMime(bytes) {
  if (!bytes || bytes.length < 4) return "image/jpeg";
  const sig = String.fromCharCode(...bytes.slice(0, 4));
  if (sig.startsWith("\xFF\xD8\xFF")) return "image/jpeg";
  if (sig.startsWith("\x89PNG")) return "image/png";
  if (sig.startsWith("RIFF")) return "image/webp";
  if (sig.startsWith("GIF8")) return "image/gif";
  return "image/jpeg";
}

// Download a Telegram file (photo/document) by file_id. Returns raw bytes.
export async function downloadTelegramFile(env, fileId) {
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const fileData = await fileRes.json();
  const path = fileData?.result?.file_path;
  if (!path) throw new Error("File tidak ditemukan di Telegram.");
  const dl = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${path}`);
  if (!dl.ok) throw new Error("Gagal download file dari Telegram.");
  const buf = await dl.arrayBuffer();
  return new Uint8Array(buf);
}

// Store raw image bytes in D1. Returns { id, fileName, mimeType, sizeBytes }.
export async function saveImageBytes(env, chatId, bytes, fileName) {
  if (!env.DB) throw new Error("D1 tidak tersedia.");
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw new Error(`Gambar terlalu besar (maks ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB).`);
  }
  const id = crypto.randomUUID().slice(0, 8);
  const mimeType = sniffMime(bytes);
  const name = fileName || "image." + (mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "jpg");
  const now = Date.now();
  const b64 = toBase64(bytes);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user_images (id, chat_id, file_name, mime_type, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, String(chatId), name, mimeType, bytes.byteLength, now, now + IMAGE_TTL_MS),
    ...Array.from(
      { length: Math.ceil(b64.length / CHUNK_B64_CHARS) },
      (_, idx) =>
        env.DB.prepare(
          "INSERT INTO user_image_chunks (image_id, idx, data_b64) VALUES (?, ?, ?)"
        ).bind(id, idx, b64.slice(idx * CHUNK_B64_CHARS, (idx + 1) * CHUNK_B64_CHARS))
    )
  ]);
  return { id, fileName: name, mimeType, sizeBytes: bytes.byteLength };
}

// Convenience: download from Telegram (by file_id) then store.
export async function saveTelegramImage(env, chatId, fileId, fileName) {
  const bytes = await downloadTelegramFile(env, fileId);
  return saveImageBytes(env, chatId, bytes, fileName);
}

// Fetch a stored image for a chat (metadata + reassembled payload).
// Returns null if missing/expired.
export async function getImage(env, id, chatId) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT id, chat_id, file_name, mime_type, size_bytes, expires_at FROM user_images WHERE id = ? AND chat_id = ?"
  ).bind(String(id), String(chatId)).first();
  if (!row) return null;
  if (row.expires_at && Date.now() > row.expires_at) {
    await deleteImage(env, id, chatId);
    return null;
  }
  const chunks = await env.DB.prepare(
    "SELECT data_b64 FROM user_image_chunks WHERE image_id = ? ORDER BY idx"
  ).bind(String(id)).all();
  const dataB64 = (chunks.results || []).map((c) => c.data_b64).join("");
  if (!dataB64) {
    await deleteImage(env, id, chatId);
    return null;
  }
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    dataB64,
    dataUrl: `data:${row.mime_type};base64,${dataB64}`
  };
}

// List stored images for a chat (id, name, size, age) — no payloads.
export async function listImages(env, chatId) {
  if (!env.DB) return [];
  const now = Date.now();
  const rows = await env.DB.prepare(
    "SELECT id, file_name, mime_type, size_bytes, created_at, expires_at FROM user_images WHERE chat_id = ? ORDER BY created_at DESC"
  ).bind(String(chatId)).all();
  return (rows.results || [])
    .filter((r) => !r.expires_at || r.expires_at > now)
    .map((r) => ({
      id: r.id,
      fileName: r.file_name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at
    }));
}

export async function deleteImage(env, id, chatId) {
  if (!env.DB) return;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_images WHERE id = ? AND chat_id = ?").bind(String(id), String(chatId)),
    env.DB.prepare("DELETE FROM user_image_chunks WHERE image_id = ?").bind(String(id))
  ]);
}

export async function deleteAllImages(env, chatId) {
  if (!env.DB) return 0;
  const rows = await env.DB.prepare("SELECT id FROM user_images WHERE chat_id = ?").bind(String(chatId)).all();
  const ids = (rows.results || []).map((r) => r.id);
  if (!ids.length) return 0;
  const stmts = [env.DB.prepare("DELETE FROM user_images WHERE chat_id = ?").bind(String(chatId))];
  for (const id of ids) {
    stmts.push(env.DB.prepare("DELETE FROM user_image_chunks WHERE image_id = ?").bind(id));
  }
  await env.DB.batch(stmts);
  return ids.length;
}

// Cron sweep: remove images past their TTL across all chats. Returns count.
export async function deleteExpiredImages(env) {
  if (!env.DB) return 0;
  const now = Date.now();
  const expired = await env.DB.prepare("SELECT id FROM user_images WHERE expires_at <= ?").bind(now).all();
  const ids = (expired.results || []).map((r) => r.id);
  if (!ids.length) return 0;
  // Chunks first: the subquery depends on user_images rows still existing.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_image_chunks WHERE image_id IN (SELECT id FROM user_images WHERE expires_at <= ?)").bind(now),
    env.DB.prepare("DELETE FROM user_images WHERE expires_at <= ?").bind(now)
  ]);
  return ids.length;
}
