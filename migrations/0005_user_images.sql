-- D1 Migration: user-uploaded images store (transient, auto-deleted after use/TTL)
-- Run: wrangler d1 execute telegram-projects --remote --file=./migrations/0005_user_images.sql

CREATE TABLE IF NOT EXISTS user_images (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data_b64 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_images_chat ON user_images (chat_id);
CREATE INDEX IF NOT EXISTS idx_user_images_exp ON user_images (expires_at);
