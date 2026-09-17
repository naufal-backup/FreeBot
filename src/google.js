// src/google.js
// Google API authentication for Cloudflare Workers using Service Account.
// Signs JWT with Web Crypto API and exchanges for access token.

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

export function extractDocIdFromUrl(input) {
  if (!input) return null;
  // Already a plain document ID (no slashes, reasonable length)
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  // Extract from Google Docs URL patterns
  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]+)/,
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/,
    /\/presentation\/d\/([a-zA-Z0-9_-]+)/
  ];
  for (const pat of patterns) {
    const m = input.match(pat);
    if (m) return m[1];
  }
  return null;
}

export function isPermissionError(msg) {
  return /permission|forbidden|403|has not been shared/i.test(msg || "");
}

export function permissionDeniedHint() {
  const email = "telegram-bot@telegram-bot-508911.iam.gserviceaccount.com";
  return [
    "Dokumen ini belum di-share ke service account.",
    "",
    "Untuk memberi izin, share dokumen ini ke:",
    `\u{1F4E7} ${email}`,
    "(role: Editor)",
    "",
    "Cara share:",
    "1. Buka dokumen di Google Docs",
    '2. Klik "Share" \u2192 masukkan email di atas',
    '3. Pilih role "Editor"',
    '4. Klik "Send"'
  ].join("\n");
}

export async function getGoogleAccessToken(serviceAccountJson) {
  const sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const { client_email, private_key } = sa;

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat: now
  }));

  const unsignedJwt = `${header}.${claim}`;
  const signature = await signJwt(unsignedJwt, private_key);
  const signedJwt = `${unsignedJwt}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Gagal get Google access token: " + (data.error || JSON.stringify(data)));
  return data.access_token;
}

async function signJwt(unsignedJwt, privateKeyPem) {
  const plainKey = privateKeyPem
    .replace(/(\r\n|\n|\r)/gm, "")
    .replace(/\\n/g, "")
    .replace(PEM_HEADER, "")
    .replace(PEM_FOOTER, "")
    .trim();

  const binaryKey = atob(plainKey);
  const keyArray = new Uint8Array(binaryKey.length);
  for (let i = 0; i < binaryKey.length; i++) {
    keyArray[i] = binaryKey.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyArray,
    { name: "RSASSA-PKCS1-V1_5", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-V1_5" },
    key,
    new TextEncoder().encode(unsignedJwt)
  );

  return arrayBufferToBase64url(sig);
}

function base64url(str) {
  return arrayBufferToBase64url(new TextEncoder().encode(str));
}

function arrayBufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function createGoogleDoc(accessToken, title) {
  const res = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal buat dokumen");
  return { documentId: data.documentId, title: data.title, url: `https://docs.google.com/document/d/${data.documentId}/edit` };
}

export async function readGoogleDoc(accessToken, documentId) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal baca dokumen");
  const content = extractDocContent(data.body?.content || []);
  return { title: data.title, content, documentId };
}

export async function appendGoogleDoc(accessToken, documentId, text) {
  // Get document to find end index
  const doc = await readGoogleDoc(accessToken, documentId);
  const endIndex = doc.content.length + 1;

  const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      requests: [{
        insertText: {
          location: { index: endIndex - 1 },
          text: text
        }
      }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal append ke dokumen");
  return { success: true, documentId };
}

export async function shareGoogleDoc(accessToken, documentId, email, role = "reader") {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ type: "user", role, emailAddress: email })
  });
  const data = await res.json();
  if (!res.ok && res.status !== 409) throw new Error(data?.error?.message || "Gagal share dokumen");
  return { success: true };
}

function extractDocContent(content) {
  const parts = [];
  for (const element of content) {
    if (element.paragraph) {
      const elements = element.paragraph.elements || [];
      for (const el of elements) {
        if (el.textRun) {
          parts.push(el.textRun.content || "");
        }
      }
    }
  }
  return parts.join("");
}

export function extractSheetIdFromUrl(input) {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input.trim())) return input.trim();
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

export async function createGoogleSheet(accessToken, title) {
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ properties: { title } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal buat spreadsheet");
  return { spreadsheetId: data.spreadsheetId, title: data.properties.title, url: data.spreadsheetUrl };
}

async function getSheetName(accessToken, spreadsheetId) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaRes.json();
  if (!meta.sheets?.length) throw new Error("Spreadsheet tidak memiliki sheet");
  return meta.sheets[0].properties.title;
}

function resolveRange(range, sheetName) {
  if (!range) return `${sheetName}!A1:Z`;
  if (range.includes("!")) {
    const parts = range.split("!");
    return `${sheetName}!${parts[parts.length - 1]}`;
  }
  return `${sheetName}!${range}`;
}

export async function readGoogleSheet(accessToken, spreadsheetId, range) {
  const sheetName = await getSheetName(accessToken, spreadsheetId);
  const r = resolveRange(range, sheetName);

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(r)}?valueRenderOption=FORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal baca spreadsheet");
  const rows = data.values || [];
  return { title: data.range, rows, spreadsheetId, sheetName };
}

export async function writeGoogleSheet(accessToken, spreadsheetId, range, values) {
  const sheetName = await getSheetName(accessToken, spreadsheetId);
  const r = resolveRange(range, sheetName);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(r)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal tulis ke spreadsheet");
  return { updatedCells: data.updatedCells || 0, spreadsheetId };
}

export async function appendGoogleSheet(accessToken, spreadsheetId, range, values) {
  const sheetName = await getSheetName(accessToken, spreadsheetId);
  const r = resolveRange(range, sheetName);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(r)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values })
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Gagal append ke spreadsheet");
  return { updatedCells: data.updates?.updatedCells || 0, spreadsheetId };
}
