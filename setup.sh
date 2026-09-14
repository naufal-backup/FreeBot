#!/usr/bin/env bash
# FreeBot - Setup otomatis Cloudflare Worker + D1 + Telegram
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }

echo "=============================================="
echo "  FreeBot - Setup Serverless AI Telegram Bot"
echo "=============================================="

# --- Prerequisites ---
command -v node >/dev/null 2>&1 || { fail "Node.js tidak ditemukan. https://nodejs.org"; exit 1; }
ok "Node.js $(node --version)"

npx --no-install wrangler --version >/dev/null 2>&1 || { fail "wrangler tidak tersedia. Jalankan: npm i -g wrangler"; exit 1; }
ok "wrangler tersedia"

if ! npx --no-install wrangler whoami >/dev/null 2>&1; then
  fail "Belum login Cloudflare. Jalankan dulu: npx wrangler login"
  exit 1
fi
ok "Cloudflare login OK"

# --- Input ---
read -rp "Nama worker [freebot]: " WORKER_NAME
WORKER_NAME=${WORKER_NAME:-freebot}
WORKER_NAME=$(echo "$WORKER_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')

while [ -z "$TELEGRAM_TOKEN" ]; do
  read -rp "TELEGRAM_TOKEN (dari @BotFather): " TELEGRAM_TOKEN
done

read -rp "AI Base URL [https://ai.geraikita.com/v1]: " AI_BASE_URL
AI_BASE_URL=${AI_BASE_URL:-https://ai.geraikita.com/v1}
AI_BASE_URL=$(echo "$AI_BASE_URL" | sed 's:/*$::')

while [ -z "$AI_API_KEY" ]; do
  read -rp "AI API Key: " AI_API_KEY
done

while [ -z "$ALLOWED_USER_IDS" ]; do
  read -rp "ALLOWED_USER_IDS (dipisah koma, kirim /myid ke bot setelah deploy): " ALLOWED_USER_IDS
done

# --- Folder ---
mkdir -p "$WORKER_NAME/src" "$WORKER_NAME/migrations"
ok "Folder project: $WORKER_NAME/"

# --- Files ---
cp src/index.js "$WORKER_NAME/src/index.js"
cp migrations/*.sql "$WORKER_NAME/migrations/"
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

# --- D1 ---
DB_CREATE_OUTPUT=$(npx wrangler d1 create telegram-projects 2>&1)
DB_ID=$(echo "$DB_CREATE_OUTPUT" | grep -oP 'database_id = "\K[^"]+' | head -1)
if [ -z "$DB_ID" ]; then
  DB_ID=$(echo "$DB_CREATE_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' | head -1)
fi
[ -z "$DB_ID" ] && { fail "Gagal membuat D1. Output: $DB_CREATE_OUTPUT"; exit 1; }
ok "D1 telegram-projects dibuat (id: $DB_ID)"

cat >> wrangler.toml <<EOF

[[d1_databases]]
binding = "DB"
database_name = "telegram-projects"
database_id = "$DB_ID"
EOF
ok "D1 binding ditambahkan ke wrangler.toml"

# --- Migrations ---
for f in migrations/0001_init.sql migrations/0002_chat_memory.sql migrations/0003_api_config.sql; do
  npx wrangler d1 execute telegram-projects --remote --file="$f" >/dev/null 2>&1 && ok "Migrasi $f OK" || warn "Migrasi $f gagal"
done

# --- Secrets ---
echo -n "$TELEGRAM_TOKEN" | npx wrangler secret put TELEGRAM_TOKEN >/dev/null 2>&1 && ok "Secret TELEGRAM_TOKEN" || warn "TELEGRAM_TOKEN gagal"
echo -n "$AI_API_KEY" | npx wrangler secret put EXTERNAL_API_KEY >/dev/null 2>&1 && ok "Secret EXTERNAL_API_KEY" || warn "EXTERNAL_API_KEY gagal"
echo -n "$ALLOWED_USER_IDS" | npx wrangler secret put ALLOWED_USER_IDS >/dev/null 2>&1 && ok "Secret ALLOWED_USER_IDS" || warn "ALLOWED_USER_IDS gagal"

WEBHOOK_SECRET=$(openssl rand -hex 32)
echo -n "$WEBHOOK_SECRET" | npx wrangler secret put WEBHOOK_SECRET >/dev/null 2>&1 && ok "Secret WEBHOOK_SECRET" || warn "WEBHOOK_SECRET gagal"

# --- Deploy ---
DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oP 'https://[a-z0-9-]+\.workers\.dev' | head -1)
[ -z "$WORKER_URL" ] && { fail "Deploy gagal. Output:"; echo "$DEPLOY_OUTPUT"; exit 1; }
ok "Deployed: $WORKER_URL"

# --- Webhook ---
CURL_RESULT=$(curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$WORKER_URL\",\"secret_token\":\"$WEBHOOK_SECRET\"}")
if echo "$CURL_RESULT" | grep -q '"ok":true'; then
  ok "Webhook diset ke $WORKER_URL"
else
  warn "setWebhook gagal: $CURL_RESULT"
fi

# --- SetMyCommands ---
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

# --- Simpan info ---
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
echo "  Webhook    : tersimpan di .env.webhook (rahasia!)"
echo "  Selanjutnya:"
echo "    1. Buka bot di Telegram, kirim /start"
echo "    2. Kirim /myid untuk dapat Telegram ID"
echo "    3. Jika ID tidak terdaftar, update secret ALLOWED_USER_IDS"
echo "       di dashboard Cloudflare, lalu deploy ulang"
echo "=============================================="