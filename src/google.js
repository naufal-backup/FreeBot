// src/google.js
// Google API authentication for Cloudflare Workers using Service Account.
// Signs JWT with Web Crypto API and exchanges for access token.

const PEM_HEADER = "-----BEGIN PRIVATE KEY-----";
const PEM_FOOTER = "-----END PRIVATE KEY-----";

export async function getGoogleAccessToken(serviceAccountJson) {
  const sa = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
  const { client_email, private_key } = sa;

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: client_email,
    scope: "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file",
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
