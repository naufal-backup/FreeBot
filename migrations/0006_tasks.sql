-- 0006_tasks.sql — antrean tugas terjadwal + pengingat

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'cron' | 'remind'
  cron_time TEXT NOT NULL,      -- format HH:MM (24 jam, dalam zona Asia/Jakarta)
  task_text TEXT NOT NULL,      -- pesan / perintah AI
  active INTEGER NOT NULL DEFAULT 1, -- 1 = aktif, 0 = nonaktif
  last_run TEXT,                -- timestamp ISO terakhir dieksekusi
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  remind_at INTEGER NOT NULL,  -- epoch (ms) Unix saatnya dipicu
  message TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);