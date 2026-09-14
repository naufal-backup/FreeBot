-- 0002_chat_memory.sql — memori konteks per room + preferensi model per room
-- chat_memory: history percakapan (JSON array [{role,content}]) per chat_id.
--   Auto-rangkum saat >= 80 entri -> diganti 1 pesan system Ringkasan.
-- chat_settings: model aktif per room. Prioritas: chat_settings > env.AI_MODEL > default.

CREATE TABLE IF NOT EXISTS chat_memory (
  chat_id TEXT PRIMARY KEY,
  history TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY,
  model TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
  updated_at INTEGER NOT NULL
);