// src/commands/googleSetup.js
// /google-setup, /google-status

import { sendTelegram } from "../telegram.js";

const GOOGLE_SETUP_GUIDE = `📋 PANDUAN GOOGLE CLOUD UNTUK FREEBOT

Fitur Google Docs/Sheets memungkinkan bot membaca, menulis, dan mengelola spreadsheet/dokumen langsung dari chat.

== STEP 1: Buat Google Cloud Project ==
1. Buka https://console.cloud.google.com
2. Klik "Select a project" → "New Project"
3. Nama: bebas (misal "freebot-google")
4. Klik "Create"
5. Tunggu beberapa detik, pastikan project baru aktif

== STEP 2: Enable API ==
Buka link ini satu-satu, klik tombol "Enable":

• Google Sheets API:
  https://console.cloud.google.com/apis/library/sheets.googleapis.com

• Google Docs API:
  https://console.cloud.google.com/apis/library/docs.googleapis.com

• Google Drive API:
  https://console.cloud.google.com/apis/library/drive.googleapis.com

== STEP 3: Buat Service Account ==
1. Buka https://console.cloud.google.com/iam-admin/serviceaccounts
2. Pilih project yang baru dibuat
3. Klik "+ CREATE SERVICE ACCOUNT"
4. Nama: misal "freebot-bot"
5. Deskripsi: boleh kosong
6. Klik "Create and Continue"
7. Role: pilih "Editor" (atau "Basic" → "Editor")
8. Klik "Continue" → "Done"

== STEP 4: Download JSON Key ==
1. Di halaman Service Accounts, klik nama service account
2. Tab "KEYS"
3. Klik "Add Key" → "Create new key"
4. Pilih "JSON" → klik "Create"
5. File JSON akan terdownload otomatis
6. SIMPAN file ini baik-baik — tidak bisa didownload ulang!

== STEP 5: Upload ke Bot ==
Kirim file JSON yang baru didownload ke bot ini.
Bot akan otomatis simpan sebagai GOOGLE_SERVICE_ACCOUNT.

Atau manual via terminal:
  cat service-account.json | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT

== STEP 6: Cek Google Drive ==
Pastikan Google Drive kamu tidak penuh.
Service account tidak punya Drive sendiri, tapi untuk CREATE spreadsheet dibutuhkan ruang Drive.

== STEP 7: Verifikasi ==
Kirim /google-status untuk cek apakah setup sudah benar.
Kirim /google-setup kapan saja untuk melihat panduan ini lagi.

== FITUR YANG TERSEDIA ==
• Baca spreadsheet: kirim link Google Sheets ke bot
• Baca dokumen: kirim link Google Docs ke bot
• Tulis/append: minta bot isi data ke spreadsheet
• Buat spreadsheet: minta bot buat spreadsheet baru
• Share dokumen: minta bot share ke email tertentu

== CATATAN PENTING ==
• Edit/write/append selalu meminta konfirmasi dulu
• Bot auto-detect nama sheet (tidak perlu tentukan manual)
• Zero hardcode — semua dinamis dari metadata spreadsheet`;

export async function handleGoogleSetupCommands(cmdWord, cmdArg, env, chatId, fromId) {
  if (cmdWord === "/google-setup") {
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, GOOGLE_SETUP_GUIDE);
    return true;
  }

  if (cmdWord === "/google-status") {
    const hasSA = !!env.GOOGLE_SERVICE_ACCOUNT;
    let status = hasSA
      ? "✅ GOOGLE_SERVICE_ACCOUNT sudah dikonfigurasi."
      : "❌ GOOGLE_SERVICE_ACCOUNT belum dikonfigurasi.\n\nKirim /google-setup untuk panduan setup.";

    if (hasSA) {
      try {
        const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
        status += `\n\n📧 Service Account: ${sa.client_email}`;
        status += `\n📁 Project: ${sa.project_id}`;
      } catch {
        status += "\n\n⚠️ Format JSON tidak valid. Upload ulang file JSON.";
      }
    }

    await sendTelegram(env.TELEGRAM_TOKEN, chatId, status);
    return true;
  }

  return false;
}
