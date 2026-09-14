-- Migration: Add processed_updates for idempotency webhook protection
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER
);