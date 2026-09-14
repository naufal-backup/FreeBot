-- 0001_init.sql — schema awal telegram-ai-bot (D1, remote)
-- projects + project_files: untuk /newproject (tahap berikutnya)
-- service_tokens: token layanan (github/supabase) murni-bot, one-time pakai lalu bisa dihapus via /logout-*

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  owner_id TEXT NOT NULL,
  github_repo TEXT,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS project_files (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS service_tokens (
  owner_id TEXT NOT NULL,
  service TEXT NOT NULL, -- 'github' | 'supabase'
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, service)
);
