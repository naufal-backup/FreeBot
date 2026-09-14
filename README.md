# FreeBot

Serverless AI Telegram Chatbot berjalan di **Cloudflare Workers** — tanpa server, tanpa database tradisional, tanpa biaya sewa VPS. Kode ES Module murni, hanya `fetch()` native, tanpa npm packages.

Bot bisa: chat AI, memori per-akun, ganti model, buat project + repo GitHub, kelola Supabase, websearch, dan kontrol akses hanya untuk ID Telegram yang diizinkan.

## Fitur

- **Chat AI** dengan model OpenAI-compatible (Geraikita, Kelontong, OpenRouter, dll.)
- **Memori konteks per room** — bot ingat percakapan, auto-rangkum tiap 80 pesan
- **Ganti model per sesi** — `/model`, daftar model live dari provider
- **Ganti provider & API key** dari dalam bot — `/changeapi`, `/changeprovider`, `/changekey`
- **Buat project** + repo GitHub langsung dari Telegram — `/newproject`
- **Kelola storage D1** — `/storage`, `/cleanup` (rekomendasi hapus FILO), `/purge`
- **Supabase on-demand** — `/need-supabase`
- **Websearch** — AI bisa cari info dari web saat dibutuhkan
- **Tool Calling** — AI punya akses eksekusi skill (project, storage, model, waktu, websearch)
- **Identitas tetap** — jawaban "siapa kamu?" deterministik, tidak bisa dimanipulasi
- **Akses terkunci** — hanya `ALLOWED_USER_IDS` yang boleh pakai
- **Endpoint privat** — webhook divalidasi `secret_token`

## Cara Install

### Prasyarat

- [Node.js](https://nodejs.org) ≥ 18
- Akun [Cloudflare](https://dash.cloudflare.com)
- Akun provider AI (atau pakai Geraikita gratis dari `opencode.jsonc` contoh)
- Bot Telegram dari [@BotFather](https://t.me/BotFather)

### Langkah

```bash
# 1. Login Cloudflare (sekali saja)
npx wrangler login

# 2. Clone + masuk
git clone https://github.com/naufal-backup/FreeBot.git
cd FreeBot

# 3. Jalankan setup interaktif
bash setup.sh
```

Script akan menanyakan:

| Input | Keterangan |
|---|---|
| Nama worker | misal `freebot` |
| TELEGRAM_TOKEN | dari @BotFather |
| AI Base URL | contoh `https://ai.geraikita.com/v1` |
| AI API Key | key provider |
| ALLOWED_USER_IDS | ID Telegram (bisa lebih dari satu, dipisah koma) |

Lalu otomatis: buat D1, apply migrasi, set secrets, deploy, set webhook, set menu perintah.

### Selesai

Buka bot di Telegram → kirim `/start`, lalu `/setup` untuk mengecek status ID kamu:

1. Kirim `/myid` → dapat Telegram ID kamu
2. Kalau ID tidak terdaftar, tambahkan ke secret `ALLOWED_USER_IDS` (re-deploy tombol di dashboard)
3. Kirim pesan bebas → bot balas dengan AI

## Struktur Project

```
FreeBot/
├── src/index.js          # Kode utama (ES Module, fetch native)
├── migrations/           # Migrasi D1
│   ├── 0001_init.sql     # projects, project_files, service_tokens
│   ├── 0002_chat_memory.sql  # chat_memory, chat_settings
│   └── 0003_api_config.sql   # api_config
├── setup.sh              # Instalasi otomatis
└── wrangler.toml         # Konfigurasi (dibuat setup)
```

## Perintah Bot

```
/start          Mulai
/help           Bantuan
/model          Lihat / ganti model sesi
/models         Daftar model (live)
/reset          Hapus memori chat
/myid           Lihat Telegram ID kamu
/newproject     Buat project + repo GitHub
/projects       List project
/storage        Status D1
/cleanup        Rekomendasi hapus project (FILO)
/purge          Hapus project dari D1
/need-supabase  Buat project Supabase
/changeapi      Ganti API sekaligus (provider + key)
/changeprovider Ganti provider, key tetap
/changekey      Ganti key, provider tetap
/api-status     Lihat API aktif
/resetapi       Kembali ke API default
/login-gh       Sambungkan GitHub
/token-gh       Simpan token GitHub
/gh-status      Cek status GitHub
/logout-gh      Hapus token GitHub
/login-sb       Sambungkan Supabase
/token-sb       Simpan token Supabase
/sb-status      Cek project Supabase
/logout-sb      Hapus token Supabase
```

## Teknologi

- **Cloudflare Workers** — serverless edge runtime
- **Cloudflare D1** — SQLite serverless (projects, memori, config)
- **Telegram Bot API** — webhook + sendMessage + sendChatAction
- **fetch() native** — tanpa npm packages

## Keamanan

- Endpoint Worker terkunci: hanya request dengan `X-Telegram-Bot-Api-Secret-Token` yang cocok
- Hanya `ALLOWED_USER_IDS` yang boleh berinteraksi (fail-closed)
- API key & token disimpan sebagai secret Cloudflare / via `/changeapi`
- Pesan berisi token dihapus otomatis di Telegram

## Lisensi

MIT — bebas dipakai dan dikembangkan.