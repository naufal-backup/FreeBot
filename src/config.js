// src/config.js
// Central, shared constants used across the bot.

export const DEFAULT_API_BASE = "https://ai.geraikita.com/v1";

export const FALLBACK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "claude-sonnet-5",
  "gpt-5.6-sol"
];

export const MAX_TOOL_ITERATIONS = 5;

export const MEMORY_MAX_ENTRIES = 80;

export const SUMMARY_MAX_CHARS = 6000;
