-- 0005_providers.sql — multi-provider API configs per-sesi
-- Provider identifier (id) = singkatan, misal "gk" untuk geraikita

CREATE TABLE IF NOT EXISTS provider_configs (
  id TEXT PRIMARY KEY,            -- singkatan unik, misal "gk", "kel", "openai", "groq"
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', -- nama tampilan, misal "Geraikita AI"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);