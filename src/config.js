// src/config.js
// Central, shared constants used across the bot.

export const DEFAULT_API_BASE = "https://ai.geraikita.com/v1";

// OpenCode Zen API — curated models for coding agents
// Docs: https://opencode.ai/docs/zen/
// Compatible models: DeepSeek, MiniMax, GLM, Kimi, Big Pickle, free models
export const ZEN_API_BASE = "https://opencode.ai/zen/v1";

export const FALLBACK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "claude-sonnet-5",
  "gpt-5.6-sol"
];

// Zen models that work with chat completions API
export const ZEN_MODELS = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", price: "$0.14/$0.28" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", price: "$1.74/$3.48" },
  { id: "minimax-m3", name: "MiniMax M3", price: "$0.30/$1.20" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", price: "$0.15/$0.50" },
  { id: "glm-5.3", name: "GLM 5.3", price: "$1.40/$4.40" },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", price: "$0.95/$4.00" },
  { id: "kimi-k3", name: "Kimi K3", price: "$3.00/$15.00" },
  { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", price: "FREE" },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", price: "FREE" },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", price: "FREE" },
  { id: "big-pickle", name: "Big Pickle", price: "FREE" },
  { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", price: "FREE" }
];

export const MAX_TOOL_ITERATIONS = 1;

export const MEMORY_MAX_ENTRIES = 80;

export const SUMMARY_MAX_CHARS = 6000;
