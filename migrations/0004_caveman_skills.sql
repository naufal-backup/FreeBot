-- D1 Migration: Add caveman mode and custom skills tables
-- Run: wrangler d1 execute telegram-projects --remote --file=./migrations/0004_caveman_skills.sql

CREATE TABLE IF NOT EXISTS user_preferences (
  chat_id TEXT PRIMARY KEY,
  caveman_mode INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS custom_tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters TEXT DEFAULT '{"type":"object","properties":{}}',
  method TEXT DEFAULT 'GET',
  url_template TEXT NOT NULL,
  headers TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(chat_id, tool_name)
);
