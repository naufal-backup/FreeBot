-- 0003_api_config.sql — konfigurasi provider AI global (bukan per-user)
-- Menyimpan base_url + api_key untuk chat/completions & /v1/models
-- Priority: api_config > default Geraikita + env.EXTERNAL_API_KEY

CREATE TABLE IF NOT EXISTS api_config (
  id TEXT PRIMARY KEY,        -- 'active'
  base_url TEXT NOT NULL,     -- contoh: https://api.kelontongai.id/v1
  api_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);