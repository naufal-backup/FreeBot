# FreeBot

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Language](https://img.shields.io/badge/language-JavaScript-yellow.svg)
![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-orange.svg)
![Runtime](https://img.shields.io/badge/runtime-ESM-purple.svg)

Serverless AI Telegram Chatbot berjalan di **Cloudflare Workers** — tanpa server, tanpa database tradisional, tanpa biaya sewa VPS. Kode ES Modular, auto-bundle oleh Wrangler.

Bot bisa: chat AI, memori per-akun, ganti model, buat project + repo GitHub, kelola Supabase, websearch, transkripsi voice note, OCR gambar/dokumen scan, dan kontrol akses hanya untuk ID Telegram yang diizinkan.

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
- **Document Reader** — baca PDF, DOCX, HTML, TXT, Markdown
- **Image OCR** — baca teks dari gambar via Cloudflare Workers AI (gratis)
- **Transkripsi Voice Note** — kirim VN, bot transkrip pakai Whisper via Workers AI
- **Cron Tasks & Reminders** — jadwalkan tugas harian dan pengingat
- **Markdown Telegram** — bold, italic, code, strikethrough, tabel, header
- **Identitas tetap** — jawaban "siapa kamu?" deterministik
- **Akses terkunci** — hanya `ALLOWED_USER_IDS` yang boleh pakai
- **Endpoint privat** — webhook divalidasi `secret_token`

## Provider yang Didukung

FreeBot tidak terikat pada satu vendor. Selama provider menyediakan endpoint **OpenAI-compatible** (`/chat/completions`), provider tersebut bisa dipakai. Cukup atur lewat `/changeapi`, `/changeprovider`, `/addprovider`, atau isi `AI_BASE_URL` + `AI_API_KEY` saat `setup.sh`.

### Provider Umum

| Provider | Base URL | Contoh Model | Auth |
|---|---|---|---|
| **Geraikita** | `https://ai.geraikita.com/v1` | `deepseek-v3`, `gpt-4o-mini`, `llama-3.3-70b` | Bearer API key |
| **Kelontong AI** | `https://kelontong.ai/v1` | `gpt-4o`, `claude-3.5-sonnet` | Bearer API key |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o`, `anthropic/claude-3.5-sonnet`, `google/gemini-2.0-flash` | Bearer API key |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile`, `mixtral-8x7b` | Bearer API key |
| **Together AI** | `https://api.together.xyz/v1` | `meta-llama/Llama-3.3-70B-Instruct-Turbo`, `Qwen/Qwen2.5-72B` | Bearer API key |
| **DeepSeek** | `https://api.deepseek.com/v1` | `deepseek-chat`, `deepseek-reasoner` | Bearer API key |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o`, `gpt-4o-mini`, `o3-mini` | Bearer API key |
| **xAI (Grok)** | `https://api.x.ai/v1` | `grok-2-latest`, `grok-2-vision` | Bearer API key |
| **Mistral** | `https://api.mistral.ai/v1` | `mistral-large-latest`, `mistral-small-latest` | Bearer API key |
| **Fireworks AI** | `https://api.fireworks.ai/inference/v1` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | Bearer API key |
| **Cerebras** | `https://api.cerebras.ai/v1` | `llama3.3-70b`, `llama3.1-8b` | Bearer API key |
| **Ollama (lokal)** | `http://localhost:11434/v1` | `llama3.3`, `qwen2.5`, `mistral` | Tanpa key / `ollama` |

> Base URL bisa berbeda tergantung versi/region provider. Selalu akhiri dengan `/v1` (kecuali provider menyebut lain).

### Cara Menambah Provider

Dua cara tersedia:

**1. Dari dalam bot** — kirim perintah:
```
/addprovider <nama> <base_url> <api_key>
```
Contoh:
```
/addprovider groq https://api.groq.com/openai/v1 gsk_xxxxxxxx
```
Lalu pilih provider tersebut dengan `/changeprovider <nama>`.

**2. Saat instalasi** — `setup.sh` menanyakan `AI Base URL` dan `AI API Key`. Isi dengan provider pilihanmu.

### Mengganti Provider & Key

| Perintah | Fungsi |
|---|---|
| `/providers` | Daftar semua provider terdaftar |
| `/changeapi` | Ganti provider + key sekaligus |
| `/changeprovider` | Ganti provider, key tetap |
| `/changekey` | Ganti key, provider tetap |
| `/addprovider` | Tambah provider baru |
| `/delprovider` | Hapus provider |
| `/api-status` | Lihat API aktif sekarang |
| `/resetapi` | Kembali ke API default |

### Catatan Kompatibilitas

- Wajib mendukung format request `messages: [{role, content}]` dan respons `choices[0].message.content`.
- Provider tanpa dukungan **tool calling** (function calling) tetap bisa chat, tetapi fitur skill/tool AI tidak aktif.
- Provider tanpa endpoint `/models` tetap bisa dipakai, hanya saja `/models` tidak menampilkan daftar live.
- Untuk provider yang butuh header khusus (mis. `HTTP-Referer` di OpenRouter), tambahkan lewat konfigurasi provider.

## Cara Install

### Prasyarat

- [Node.js](https://nodejs.org) ≥ 18
- Akun [Cloudflare](https://dash.cloudflare.com)
- Akun provider AI (atau pakai Geraikita)
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

Lalu otomatis: install deps, buat D1, apply migrasi, set secrets, deploy, set webhook, set menu perintah.

### Selesai

Buka bot di Telegram → kirim `/start`:

1. Kirim `/myid` → dapat Telegram ID kamu
2. Kalau ID tidak terdaftar, tambahkan ke secret `ALLOWED_USER_IDS`
3. Kirim pesan bebas → bot balas dengan AI
4. Kirim dokumen (PDF/DOCX/HTML/TXT/MD/gambar) → bot baca & ringkas

## Struktur Project

```
FreeBot/
├── src/
│   ├── index.js              # Entry point (fetch + scheduled)
│   ├── config.js             # Konstanta bersama
│   ├── telegram.js           # Telegram Bot API
│   ├── github.js             # GitHub REST API
│   ├── supabase.js           # Supabase Management API
│   ├── models.js             # Model & provider management
│   ├── storage.js            # D1 persistence (tokens, memory)
│   ├── documents.js          # Document extraction (PDF/DOCX/HTML/TXT/MD)
│   ├── ocr.js                # OCR via Cloudflare Workers AI
│   ├── templates.js          # Project scaffold templates
│   ├── identity.js           # Identity question detection
│   ├── scheduled.js          # Cron & reminder runner
│   ├── commands/
│   │   ├── basic.js          # /start /help /model /models /reset
│   │   ├── auth.js           # /login-gh /token-gh /gh-status /login-sb ...
│   │   ├── apiConfig.js      # /changeapi /changeprovider /providers ...
│   │   ├── projects.js       # /newproject /projects /storage /cleanup /purge
│   │   └── schedule.js       # /cron /crons /delcron /remind /reminds
│   ├── tools/
│   │   ├── definitions.js    # Tool schema (function calling)
│   │   └── executor.js       # Tool execution
│   └── utils/
│       ├── format.js         # fmtBytes, maskApiKey
│       ├── time.js           # Natural language time parser
│       └── markdown.js       # Markdown → Telegram HTML
├── migrations/               # D1 SQL migrations
├── setup.sh                  # Instalasi otomatis
└── wrangler.toml             # Konfigurasi (dibuat setup)
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
/cron           Buat cron harian
/crons          Daftar cron
/delcron        Hapus cron
/remind         Buat pengingat
/reminds        Daftar pengingat
/addprovider    Tambah AI provider
/delprovider    Hapus provider
/providers      Daftar provider
```

## Format Dokumen yang Didukung

| Format | Ekstensi | Keterangan |
|--------|----------|------------|
| PDF | `.pdf` | Text extraction + OCR untuk scan |
| DOCX | `.docx` | XML parsing + OCR untuk gambar |
| HTML | `.html`, `.htm` | Strip tags, decode entities |
| Plain Text | `.txt` | Langsung baca |
| Markdown | `.md` | Langsung baca |
| Gambar | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | OCR via Cloudflare AI |

## Teknologi

- **Cloudflare Workers** — serverless edge runtime
- **Cloudflare D1** — SQLite serverless (projects, memori, config)
- **Cloudflare Workers AI** — OCR & vision models (gratis)
- **Telegram Bot API** — webhook + sendMessage + sendChatAction
- **ES Modules** — auto-bundle oleh Wrangler

## Keamanan

- Endpoint Worker terkunci: hanya request dengan `X-Telegram-Bot-Api-Secret-Token` yang cocok
- Hanya `ALLOWED_USER_IDS` yang boleh berinteraksi (fail-closed)
- API key & token disimpan sebagai secret Cloudflare / via `/changeapi`
- Pesan berisi token dihapus otomatis di Telegram
- Chat queue per-room: serialisasi AI processing (cegah race condition)

## Lisensi

MIT — bebas dipakai dan dikembangkan.
