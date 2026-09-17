// src/identity.js
// Detects "who are you / who made you" style questions and returns the
// bot's fixed canonical identity answer, bypassing the AI model entirely.

export function canonicalIdentityAnswer(text, model) {
  const norm = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const botRef = /\b(kamu|kau|anda|lu|lo|bot|u)\b/.test(norm);
  if (!botRef) return null;

  const identityWords = [
    "siapa",
    "pembuat",
    "pencipta",
    "pemilik",
    "owner",
    "developer",
    "dibuat",
    "membuat",
    "bikinan",
    "bikin",
    "buatan",
    "ciptaan",
    "model",
    "nama",
    "tentang",
    "profil",
    "identitas",
    "who are you",
    "who made",
    "who created",
    "who built",
    "who owns",
    "created by",
    "your creator",
    "your model",
    "your name",
    "your owner",
    "made by",
    "built by"
  ];
  const hasIdentity = identityWords.some((w) => norm.includes(w));
  if (!hasIdentity) return null;

  return `aku adalah bot buatan Naufal Alamsyah menggunakan model ${model}`;
}
