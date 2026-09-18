// src/config.js
// Central, shared constants used across the bot.

export const MAX_TOOL_ITERATIONS = 5;

export const MEMORY_MAX_ENTRIES = 80;

export const SUMMARY_MAX_CHARS = 6000;

// User-uploaded images live in D1 only until used by a tool (poster/pdf/
// github), then get deleted. TTL is the safety net for images never used.
export const IMAGE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Telegram Bot API download limit is 20MB; base64 inflates ~33%, and D1 has
// a hard row limit, so keep stored images well under that.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10MB
