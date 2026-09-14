#!/usr/bin/env bash
# FreeBot - Setup otomatis Cloudflare Worker + D1 + Telegram
# Jalankan: bash setup.sh
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

echo "=============================================="
echo "  FreeBot - Setup Serverless AI Telegram Bot"
echo "=============================================="

# ============================================================
# 1. Prasyarat wajib
# ============================================================
command -v node >/dev/null 2>&1 || fail "Node.js tidak ditemukan. https://nodejs.org (min v18)"
ok "Node.js $(node --version)"

if ! npx --no-install wrangler --version >/dev/null 2>&1; then
  warn "wrangler tidak ditemukan, coba install: npm i -g wrangler"
  read -rp "Lanjutkan setelah install? [Y/n] " yn
  [[ "$yn" =~ ^[Nn] ]] && exit 0
  npm i -g wrangler || fail "Gagal install wrangler"
fi
ok "wrangler tersedia"

if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  fail "Belum login Cloudflare. Jalankan dulu: npx wrangler login"
fi
ok "Cloudflare login OK"

# ============================================================
# 2. Input user
# ============================================================
read -rp "Nama worker [freebot]: " WORKER_NAME
WORKER_NAME=${WORKER_NAME:-freebot}
WORKER_NAME=$(echo "$WORKER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')

while [ -z "${TELEGRAM_TOKEN:-}" ]; do
  read -rp "TELEGRAM_TOKEN (dari @BotFather): " TELEGRAM_TOKEN
done
# Validasi token format dasar (numerik:AAA...)
if ! echo "$TELEGRAM_TOKEN" | grep -qE '^[0-9]+:AA'; then
  warn "Format TELEGRAM_TOKEN terlihat tidak standar. Lanjutkan? [y/N]"
  read -r yn; [[ "$yn" != "y" ]] && fail "Batal."
fi

read -rp "AI Provider Base URL [https://ai.geraikita.com/v1]: " AI_BASE_URL
AI_BASE_URL=${AI_BASE_URL:-https://ai.geraikita.com/v1}
AI_BASE_URL=$(echo "$AI_BASE_URL" | sed 's:/*$::')

while [ -z "${AI_API_KEY:-}" ]; do
  read -rp "AI API Key: " AI_API_KEY
done

while [ -z "${ALLOWED_USER_IDS:-}" ]; do
  read -rp "ALLOWED_USER_IDS (1 atau lebih, pisah koma. Ambil dari /myid): " ALLOWED_USER_IDS
done

# ============================================================
# 3. Buat folder projekt & salin file template
# ============================================================
mkdir -p "$WORKER_NAME/src" "$WORKER_NAME/migrations"
ok "Folder project: $WORKER_NAME/"

cp src/index.js "$WORKER_NAME/src/index.js"      || fail "File src/index.js tidak ditemukan. Pastikan setup.sh dijalankan dari root direktori repo FreeBot."
for f in migrations/*.sql; do
  [ -f "$f" ] || continue
  cp "$f" "$WORKER_NAME/migrations/"
done
ok "Kode + migrasi disalin"

cat > "$WORKER_NAME/wrangler.toml" <<EOF
name = "$WORKER_NAME"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true

[vars]
STORAGE_QUOTA_BYTES = "419430400"
EOF
ok "wrangler.toml dibuat"

cat > "$WORKER_NAME/package.json" <<'EOF'
{
  "name": "freebot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
EOF
ok "package.json dibuat"

cd "$WORKER_NAME"

# ============================================================
# 4. D1: database + migrasi
# ============================================================
DB_CREATE_OUTPUT=$(npx wrangler d1 create telegram-projects 2>&1)
DB_ID=$(echo "$DB_CREATE_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' | head -1)
[ -z "$DB_ID" ] && fail "Gagal membuat D1. Output: $DB_CREATE_OUTPUT"
ok "D1 telegram-projects dibuat (id: $DB_ID)"

cat >> wrangler.toml <<EOF

[[d1_databases]]
binding = "DB"
database_name = "telegram-projects"
database_id = "$DB_ID"
EOF
ok "D1 binding ditambahkan"

for f in migrations/*.sql; do
  [ -f "$f" ] || continue
  npx wrangler d1 execute telegram-projects --remote --file="$f" >/dev/null 2>&1 \
    && ok "Migrasi $(basename "$f") OK" \
    || warn "Migrasi $(basename "$f") gagal"
done

# ============================================================
# 5. Secrets (aman — tidak tersimpan di file)
# ============================================================
echo -n "$TELEGRAM_TOKEN"      | npx wrangler secret put TELEGRAM_TOKEN      >/dev/null 2>&1 && ok "Secret TELEGRAM_TOKEN"      || warn "TELEGRAM_TOKEN gagal"
echo -n "$AI_API_KEY"          | npx wrangler secret put EXTERNAL_API_KEY    >/dev/null 2>&1 && ok "Secret EXTERNAL_API_KEY"    || warn "EXTERNAL_API_KEY gagal"
echo -n "$ALLOWED_USER_IDS"    | npx wrangler secret put ALLOWED_USER_IDS    >/dev/null 2>&1 && ok "Secret ALLOWED_USER_IDS"    || warn "ALLOWED_USER_IDS gagal"

WEBHOOK_SECRET=$(openssl rand -hex 32)
echo -n "$WEBHOOK_SECRET"      | npx wrangler secret put WEBHOOK_SECRET     >/dev/null 2>&1 && ok "Secret WEBHOOK_SECRET"     || warn "WEBHOOK_SECRET gagal"

# ============================================================
# 6. Deploy Worker
# ============================================================
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-z0-9-]+\.workers\.dev' | head -1)
[ -z "$WORKER_URL" ] && fail "Deploy gagal. Output:\n$DEPLOY_OUTPUT"
ok "Deployed: $WORKER_URL"

# ============================================================
# 7. Set Webhook Telegram
# ============================================================
CURL_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WORKER_URL\",\"secret_token\":\"$WEBHOOK_SECRET\"}")
if echo "$CURL_RESULT" | grep -q '"ok":true'; then
  ok "Webhook diset ke $WORKER_URL"
else
  warn "setWebhook gagal: $CURL_RESULT"
fi

# ============================================================
# 8. SetBotCommands
# ============================================================
python3 - "$TELEGRAM_TOKEN" <<'PY'
import json, subprocess, sys
token = sys.argv[1]
commands = [
  ("start","Mulai bot"),("help","Bantuan & daftar perintah"),
  ("model","Lihat/ganti model sesi"),("models","Daftar model (live)"),
  ("reset","Hapus memori chat sesi"),("myid","Lihat Telegram ID kamu"),
  ("newproject","Buat project + repo GitHub"),("projects","List project"),
  ("storage","Status D1"),("cleanup","Rekomendasi hapus FILO"),
  ("purge","Hapus project dari D1"),("need_supabase","Buat project Supabase"),
  ("changeapi","Ganti API sekaligus"),("changeprovider","Ganti provider, key tetap"),
  ("changekey","Ganti key, provider tetap"),("api_status","Lihat API aktif"),
  ("resetapi","Kembali ke API default"),
  ("login_gh","Sambung GitHub"),("gh_status","Cek GitHub"),("logout_gh","Hapus token GitHub"),
  ("login_sb","Sambung Supabase"),("sb_status","Cek Supabase"),("logout_sb","Hapus token Supabase"),
]
body = json.dumps({"commands":[{"command":c,"description":d} for c,d in commands]})
subprocess.run(["curl","-s","-X","POST",f"https://api.telegram.org/bot{token}/setMyCommands","-H","Content-Type: application/json","-d",body])
PY
ok "Bot commands terpasang"

# ============================================================
# 9. Simpan info kunci (rahasia – jangan commit)
# ============================================================
cp wrangler.toml wrangler.toml.bak
cat > .env.webhook <<EOF
WORKER_URL=$WORKER_URL
WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
chmod 600 .env.webhook

echo "=============================================="
echo -e "${GREEN}  SELESAI! 🎉${NC}"
echo "=============================================="
echo "  Worker URL : $WORKER_URL"
echo "  Webhook    : tersimpan di .env.webhook (jangan di-commit)"
echo ""
echo "  Langkah selanjutnya (via Telegram):"
echo "    1. Chat bot → /start"
echo "    2. /myid → catat ID Telegram kamu"
echo "    3. Kalau perlu ubah ALLOWED_USER_IDS:"
echo "       npx wrangler secret put ALLOWED_USER_IDS"
echo "    4. Sambung GitHub: /login-gh → buat token → /token-gh <token>"
echo "    5. /newproject <nama> → buat project baru"
echo ""
echo "  Butuh transkripsi voice? Setup audio worker manual:"
echo "    Lihat dokumentasi di https://github.com/naufal-backup/FreeBot#readme"
echo "=============================================="