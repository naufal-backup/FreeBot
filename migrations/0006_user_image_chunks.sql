-- D1 Migration: chunked storage for user images.
-- D1 rejects bound parameters over ~1MB, and base64 inflates images ~33%,
-- so image payloads are split across rows instead of one data_b64 column.
-- Run: wrangler d1 execute telegram-projects --remote --file=./migrations/0006_user_image_chunks.sql

CREATE TABLE IF NOT EXISTS user_image_chunks (
  image_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  PRIMARY KEY (image_id, idx)
);
