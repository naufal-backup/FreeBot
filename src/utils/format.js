// src/utils/format.js
// Small, stateless formatting helpers.

export function fmtBytes(n) {
  if (!Number.isFinite(n)) n = 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function maskApiKey(key) {
  if (!key || key.length < 12) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
