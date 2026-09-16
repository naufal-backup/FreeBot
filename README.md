# telegram-ai-bot — struktur file

Kode asli (satu file besar hasil bundle) sudah dipecah jadi modul-modul ES
(`import`/`export`) di bawah `src/`. `wrangler` akan otomatis bundle semua
ini kembali jadi satu file saat deploy — cukup pastikan `main = "src/index.js"`
di `wrangler.toml`.

```
src/
├── index.js              # Entry point: fetch() (webhook Telegram) + scheduled() (cron)
├── config.js             # Konstanta bersama (DEFAULT_API_BASE, FALLBACK_MODELS, dst)
├── telegram.js           # sendTelegram, sendTelegramDocument, deleteMessage, voice transcribe
├── github.js             # Semua panggilan GitHub REST API
├── supabase.js           # Validasi token & list project Supabase
├── models.js             # Model aktif per-chat, provider config, resolve model:provider
├── storage.js            # D1: service_tokens, storage usage, chat memory, ringkasan
├── documents.js          # Ekstraksi teks PDF & DOCX
├── templates.js          # Scaffold project (worker-hello / worker-api / ai-chat)
├── identity.js           # Deteksi pertanyaan "siapa kamu / siapa pembuatmu"
├── scheduled.js          # Runner cron task + reminder (dipanggil dari Cron Trigger)
├── utils/
│   ├── time.js           # parseNaturalTime (parsing waktu bahasa natural ID/EN)
│   ├── format.js         # fmtBytes, maskApiKey, arrayBufferToBase64
│   └── markdown.js       # markdownToHtml + render tabel monospace utk Telegram
├── tools/
│   ├── definitions.js    # Skema TOOL_DEFINITIONS (function-calling)
│   └── executor.js       # executeTool() — implementasi tiap tool
└── commands/
    ├── basic.js          # /start /help /model /models /reset
    ├── auth.js           # /login-gh /token-gh /gh-status /logout-gh /login-sb ...
    ├── apiConfig.js      # /changeapi /changeprovider /changekey /api-status /providers ...
    ├── projects.js       # /newproject /projects /storage /cleanup /purge /need-supabase
    └── schedule.js       # /cron /crons /delcron /remind /reminds
```

`/stop` dan `/myid` tetap ditangani langsung di `index.js` (sebelum
pengecekan `ALLOWED_USER_IDS`), sama seperti perilaku aslinya.

## Catatan perbaikan kecil
`extractDocxText` di file asli memakai variabel `m` dalam loop `while` tanpa
`let`/`const` (`while ((m = wtRe.exec(xml)) !== null)`). Di ES Module,
mode strict aktif otomatis, jadi baris ini akan melempar
`ReferenceError: m is not defined` dan fitur baca DOCX gagal diam-diam
(ketangkap try/catch, balik pesan error). Sudah diperbaiki di
`src/documents.js` (`let m;` dideklarasikan). Semua bug lain / perilaku
lain dipertahankan persis seperti aslinya.

## Menjalankan
```bash
npm install    # jika belum ada node_modules / wrangler
wrangler dev
wrangler deploy
```
