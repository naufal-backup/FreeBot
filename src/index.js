var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var index_default = {
  async fetch(request, env, ctx) {
    const secretToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (request.method !== "POST" || !env.WEBHOOK_SECRET || secretToken !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    let update;
try {
  update = await request.json();
} catch {
  return new Response("OK", { status: 200 });
}

// --- TAMBAHKAN KODE INI UNTUK CEK IDEMPOTENCY ---
const updateId = update?.update_id;
if (updateId && env.DB) {
  try {
    // Cek apakah update_id sudah pernah diproses
    const existing = await env.DB.prepare("SELECT update_id FROM processed_updates WHERE update_id = ?").bind(updateId).first();
    if (existing) {
      return new Response("OK", { status: 200 }); // Abaikan duplikat request
    }
    // Simpan update_id baru (dengan masa kedaluwarsa opsional atau langsung simpan)
    await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id, created_at) VALUES (?, ?)").bind(updateId, Date.now()).run();
  } catch (err) {
    console.error("Idempotency check error:", err);
  }
}
// ------------------------------------------------
    const chatId = update?.message?.chat?.id;
    const voiceInfo = update?.message?.voice;
    const photoInfo = update?.message?.photo;
    let userText = update?.message?.text || update?.message?.caption;
    const fromId = update?.message?.from?.id;
    const messageId = update?.message?.message_id;
    if (!chatId || !fromId) {
      return new Response("OK", { status: 200 });
    }

    let imageBase64 = null;
    if (photoInfo && photoInfo.length > 0) {
      const highestRes = photoInfo[photoInfo.length - 1];
      if (highestRes.file_size > 5 * 1024 * 1024) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gambar terlalu besar (maks 5MB).");
        return new Response("OK", { status: 200 });
      }
      imageBase64 = await getTelegramImageBase64(env, highestRes.file_id);
      if (!userText) userText = "Jelaskan apa yang ada di gambar ini secara detail.";
    }

    if (!userText && voiceInfo) {
      const transcribed = await transcribeVoiceNote(env, voiceInfo, chatId);
      if (transcribed === null) {
        return new Response("OK", { status: 200 });
      }
      userText = transcribed;
    }

    if (!userText && !imageBase64) {
      return new Response("OK", { status: 200 });
    }

    const cmdWord = userText.split(/\s+/)[0].replace(/_/g, "-");
    const cmdArg = userText.includes(" ") ? userText.slice(userText.indexOf(" ") + 1).trim() : "";
    if (cmdWord === "/myid") {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Your ID: ${fromId}`);
      return new Response("OK", { status: 200 });
    }
    const allowed = (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(String(fromId))) {
      console.log(`Blocked unauthorized user: ${fromId}`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/start") {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Halo! Kirim pesan apa saja, saya balas dengan AI.\n\nKetik /help untuk daftar perintah.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/help") {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model sesi\n/models - daftar model\n/reset - hapus memori chat sesi\n/myid - lihat Telegram ID kamu\n/newproject <nama> [template] - buat project (custom-project|worker-hello|worker-api|ai-chat) + repo GitHub\n/projects - list project\n/storage - status D1\n/cleanup - rekomendasi hapus (FILO)\n/purge <nama> yes - hapus dari D1\n/need-supabase <nama> - buat project Supabase\n/login-gh /token-gh <pat> /gh-status /logout-gh - kelola GitHub\n/login-sb /token-sb <pat> /sb-status /logout-sb - kelola Supabase\n/changeapi <url> <key> - ganti API sekaligus (provider + key)\n/changeprovider <url> - ganti provider, key tetap\n/changekey <key> - ganti key, provider tetap\n/api-status - lihat API aktif\n/resetapi - kembali ke default\n\nKetik teks bebas untuk chat AI."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/model") {
      const activeModel = await getActiveModel(env, chatId);
      const target = cmdArg.split(/\s+/)[0];
      if (!target) {
        const list = await formatModelList(env);
        const modelList = list ? `\n\nModel tersedia (live /v1/models):\n${list}` : "\n\n(daftar model gagal dimuat)";
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model aktif sesi ini: ${activeModel}\nGanti: /model <nama>.${modelList}`);
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const models = await fetchModelList(env);
      const exists = models ? models.some((m) => m.id === target) : FALLBACK_MODELS.includes(target);
      if (!exists) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model "${target}" tidak dikenal. Gunakan /model untuk melihat daftar.`);
        return new Response("OK", { status: 200 });
      }
      await setActiveModel(env, chatId, target);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model sesi ini diganti ke: ${target}`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/models") {
      const activeModel = await getActiveModel(env, chatId);
      const list = await formatModelList(env);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        list ? `Model aktif: ${activeModel}\n\nDaftar model (live /v1/models):\n${list}` : "Gagal memuat daftar model dari Geraikita. Coba lagi nanti."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/reset") {
      if (env.DB) {
        await env.DB.prepare("DELETE FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Memori chat sesi ini dihapus. Konteks sebelumnya tidak lagi diingat.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/login-gh") {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Sambung GitHub:\n1. Buka github.com/settings/tokens (Fine-grained, expiry \u22647 hari, scope Contents read-write untuk repo target)\n2. Copy token\n3. Kirim ke sini: /token-gh <token>\nPesan token langsung saya hapus setelah dibaca."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/token-gh") {
      const pat = cmdArg.split(/\s+/)[0] || "";
      if (pat.length < 20) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /token-gh <token>. Token terlalu pendek, cek lagi.");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
        return new Response("OK", { status: 200 });
      }
      const login = await validateGithubToken(pat);
      if (!login) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub tidak valid. Buat baru lalu kirim ulang.");
        return new Response("OK", { status: 200 });
      }
      await env.DB.prepare(
        "INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)"
      ).bind(String(fromId), "github", pat, Date.now()).run();
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `GitHub tersambung sebagai @${login}. Pesan token sudah dihapus.`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/gh-status") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
        return new Response("OK", { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, "github");
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "GitHub belum tersambung. Kirim /login-gh dulu.");
        return new Response("OK", { status: 200 });
      }
      const login = await validateGithubToken(pat);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        login ? `GitHub tersambung sebagai @${login}.` : "Token GitHub tersimpan tapi tidak valid lagi. Kirim /token-gh baru atau /logout-gh."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/logout-gh") {
      if (env.DB) {
        await env.DB.prepare("DELETE FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), "github").run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub dihapus dari bot. Revoke juga di github.com/settings/tokens.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/login-sb") {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Sambung Supabase:\n1. Buka supabase.com/dashboard/account/tokens \u2192 Create new token\n2. Copy token (sbp_...)\n3. Kirim ke sini: /token-sb <token>\nPesan token langsung saya hapus setelah dibaca."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/token-sb") {
      const pat = cmdArg.split(/\s+/)[0] || "";
      if (pat.length < 20) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /token-sb <token>. Token terlalu pendek, cek lagi.");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
        return new Response("OK", { status: 200 });
      }
      const ok = await validateSupabaseToken(pat);
      if (!ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token Supabase tidak valid. Buat baru lalu kirim ulang.");
        return new Response("OK", { status: 200 });
      }
      await env.DB.prepare(
        "INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)"
      ).bind(String(fromId), "supabase", pat, Date.now()).run();
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase tersambung. Pesan token sudah dihapus. Operasi project (/need-supabase) menyusul.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/sb-status") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
        return new Response("OK", { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, "supabase");
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase belum tersambung. Kirim /login-sb dulu.");
        return new Response("OK", { status: 200 });
      }
      const names = await listSupabaseProjects(pat);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        names === null ? "Token Supabase tersimpan tapi tidak valid lagi. Kirim /token-sb baru atau /logout-sb." : names.length === 0 ? "Supabase tersambung. Belum ada project." : `Supabase tersambung. Projects (${names.length}):\n${names.slice(0, 10).join("\n")}`
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/logout-sb") {
      if (env.DB) {
        await env.DB.prepare("DELETE FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), "supabase").run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token Supabase dihapus dari bot. Revoke juga di dashboard Supabase.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/changeapi") {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const baseUrl = args[0] || "";
      const apiKey = args.slice(1).join(" ") || "";
      if (!baseUrl || !apiKey) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changeapi <base_url> <api_key>\nContoh: /changeapi https://api.kelontongai.id/v1 sk-xxx...");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      try {
        const testRes = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API tidak valid (HTTP ${testRes.status}). Cek base_url dan key.`);
          return new Response("OK", { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke API: ${err.message}`);
        return new Response("OK", { status: 200 });
      }
      await setApiConfig(env, baseUrl, apiKey);
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API diganti ke: ${baseUrl}\n(Simpan, pesan key dihapus.)`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/changeprovider") {
      const baseUrl = (cmdArg.trim() || "").replace(/\/+$/, "");
      if (!/^https?:\/\//.test(baseUrl)) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changeprovider <base_url>\nContoh: /changeprovider https://api.kelontongai.id/v1\n(Key tetap dipertahankan.)");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const existing = await getApiConfig(env);
      const apiKey = existing?.api_key || env.EXTERNAL_API_KEY || "";
      try {
        const testRes = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider tidak valid (HTTP ${testRes.status}). Cek base_url & key aktif.`);
          return new Response("OK", { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke provider: ${err.message}`);
        return new Response("OK", { status: 200 });
      }
      await setApiBase(env, baseUrl);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider diganti ke: ${baseUrl}\nKey tetap: ${maskApiKey(apiKey)}`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/changekey") {
      const apiKey = cmdArg.split(/\s+/)[0] || "";
      if (apiKey.length < 10) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /changekey <api_key>\nKey terlalu pendek. Contoh: /changekey sk-xxx...");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const existing = await getApiConfig(env);
      const base_url = existing?.base_url || DEFAULT_API_BASE;
      try {
        const testRes = await fetch(`${base_url}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key tidak valid untuk ${base_url} (HTTP ${testRes.status}).`);
          return new Response("OK", { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi: ${err.message}`);
        return new Response("OK", { status: 200 });
      }
      await setApiKey(env, apiKey);
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key API diganti (provider: ${base_url}). Pesan key dihapus.`);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/api-status") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const config = await getApiConfig(env);
      if (config) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API aktif: ${config.base_url}\nKey: ${maskApiKey(config.api_key)}\n\n/resetapi untuk kembali ke default.`);
      } else {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API default: ${DEFAULT_API_BASE}\nGunakan /changeapi untuk ganti.`);
      }
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/resetapi") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      await clearApiConfig(env);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API dikembalikan ke default: ${DEFAULT_API_BASE}`);
      return new Response("OK", { status: 200 });
    }
    // if (cmdWord === "/newproject") {
    //   const args = cmdArg.split(/\s+/).filter(Boolean);
    //   const projName = (args[0] || "").toLowerCase();
    //   const template = (args[1] || "worker-hello").toLowerCase();
    //   if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(projName)) {
    //     // await sendTelegram(
    //     //   env.TELEGRAM_TOKEN,
    //     //   chatId,
    //     //   "Format: /newproject <nama> [template]\nnama: huruf kecil, angka, strip; 3-50 karakter.\nTemplate: custom-project | worker-hello | worker-api | ai-chat"
    //     // );
    //     // return new Response("OK", { status: 200 });
    //   }
    //   if (!env.DB) {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
    //     return new Response("OK", { status: 200 });
    //   }
    //   const pat = await getServiceToken(env, fromId, "github");
    //   if (!pat) {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, "GitHub belum tersambung. Kirim /login-gh dulu.");
    //     return new Response("OK", { status: 200 });
    //   }
    //   const githubLogin = await validateGithubToken(pat);
    //   if (!githubLogin) {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub tidak valid. Kirim /token-gh baru lalu ulangi.");
    //     return new Response("OK", { status: 200 });
    //   }
    //   const files = renderTemplate(template, projName);
    //   if (!files) {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Template tidak dikenal: gunakan custom-project, worker-hello, worker-api, atau ai-chat.");
    //     return new Response("OK", { status: 200 });
    //   }
    //   const totalBytes = files.reduce((s, f) => s + f.size, 0);
    //   const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
    //   const usage = await getStorageUsage(env);
    //   if (usage + totalBytes > quota * 0.95) {
    //     await sendTelegram(
    //       env.TELEGRAM_TOKEN,
    //       chatId,
    //       `Storage D1 hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Kirim /cleanup untuk melihat rekomendasi hapus, atau /storage.`
    //     );
    //     return new Response("OK", { status: 200 });
    //   }
    //   const dup = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
    //   if (dup) {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" sudah ada (termasuk punya user lain). Pilih nama lain.`);
    //     return new Response("OK", { status: 200 });
    //   }
    //   try {
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Membuat project "${projName}" (${template})...`);
    //     const repo = await createGithubRepo(pat, projName);
    //     const fullName = repo.full_name;
    //     const pushed = await pushFilesToGithub(pat, fullName, files);
    //     if (!pushed) {
    //       await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Repo ${fullName} dibuat tapi push file gagal. Coba /purge lalu ulangi.`);
    //       return new Response("OK", { status: 200 });
    //     }
    //     const now = Date.now();
    //     await env.DB.prepare(
    //       "INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)"
    //     ).bind(projName, String(fromId), fullName, totalBytes, now, now).run();
    //     const projRow = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
    //     await env.DB.batch(
    //       files.map(
    //         (f) => env.DB.prepare("INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(projRow.id, f.path, f.content, f.size)
    //       )
    //     );
    //     await sendTelegram(
    //       env.TELEGRAM_TOKEN,
    //       chatId,
    //       `Project jadi: ${fullName}\nFile: ${files.length} (${fmtBytes(totalBytes)})\nRepo: https://github.com/${fullName}\nSimpanan: ${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}`
    //     );
    //   } catch (err) {
    //     console.error(err);
    //     await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat project: ${err.message}`);
    //   }
    //   return new Response("OK", { status: 200 });
    // }
    if (cmdWord === "/projects") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const rows = await env.DB.prepare(
        "SELECT name, github_repo, total_bytes, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25"
      ).bind(String(fromId)).all();
      const list = (rows.results || []).map((p) => `- ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 ${new Date(p.created_at).toISOString().slice(0, 10)} (${p.github_repo})`).join("\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? `Projects (${rows.results.length}):\n${list}` : "Belum ada project. Ketik /newproject <nama> [template].");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/storage") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
      const usage = await getStorageUsage(env);
      const rows = await env.DB.prepare(
        "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC LIMIT 10"
      ).all();
      const filo = (rows.results || []).map((p, i) => `#${i + 1} ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`).join("\n");
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        "Storage D1: " + fmtBytes(usage) + " / " + fmtBytes(quota) + " (" + (usage / quota * 100).toFixed(1) + "%)\n\nUrutan hapus FILO (terbaru dulu):\n" + (filo || "(kosong)") + "\n\n/cleanup untuk rekomendasi, /purge <nama> [yes] untuk hapus."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/cleanup") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const rows = await env.DB.prepare(
        "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10"
      ).all();
      const rec = (rows.results || []).map((p, i) => `#${i + 1} ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 akses terakhir ${new Date(p.last_accessed_at || p.created_at).toISOString().slice(0, 10)}`).join("\n");
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        (rec ? `Rekomendasi hapus (FILO terbaru dulu):\n${rec}\n\nKonfirmasi: /purge <nama> yes` : "Tidak ada project untuk dibersihkan.") + "\nCatatan: hapus hanya dari D1, repo GitHub tetap aman."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/purge") {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const projName = args[0] || "";
      const yes = args[1] === "yes";
      if (!yes) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Yakin hapus "${projName}" dari D1? Balas: /purge ${projName} yes\n(Repo GitHub tidak dihapus.)`);
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const row = await env.DB.prepare("SELECT id FROM projects WHERE name = ? AND owner_id = ?").bind(projName, String(fromId)).first();
      if (!row) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" tidak ditemukan milikmu.`);
        return new Response("OK", { status: 200 });
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM project_files WHERE project_id = ?").bind(row.id),
        env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id)
      ]);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`);
      return new Response("OK", { status: 200 });
    } 
    if (cmdWord === "/need-supabase") {
      const projName = (cmdArg.split(/\s+/)[0] || "").toLowerCase();
      if (!/^[a-z][a-z0-9-]{2,23}$/.test(projName)) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /need-supabase <nama>\nnama: huruf kecil, angka, strip; 3-24 karakter.");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, "supabase");
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase belum tersambung. Kirim /login-sb dulu.");
        return new Response("OK", { status: 200 });
      }
      try {
        const orgs = await fetch("https://api.supabase.com/v1/organizations", {
          headers: { Authorization: `Bearer ${pat}` }
        });
        if (!orgs.ok) throw new Error("Organisasi Supabase tidak valid.");
        const orgList = await orgs.json();
        const orgId = (Array.isArray(orgList) ? orgList[0]?.id : null) || "";
        if (!orgId) throw new Error("Akun Supabase belum punya organisasi.");
        const createRes = await fetch("https://api.supabase.com/v1/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${pat}` },
          body: JSON.stringify({
            name: projName,
            organization_id: orgId,
            plan: "free",
            region: "ap-southeast-1"
          })
        });
        const created = await createRes.json();
        if (!createRes.ok) throw new Error(created?.message || "Gagal create project Supabase.");
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Project Supabase "${projName}" sedang diprovisioning (ref: ${created?.ref || created?.id || "?"}).\nCek status: /sb-status (bisa butuh beberapa menit).`
        );
      } catch (err) {
        console.error(err);
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat Supabase project: ${err.message}`);
      }
      return new Response("OK", { status: 200 });
    }
    const activeModelForId = await getActiveModel(env, chatId);
    const identityAnswer = canonicalIdentityAnswer(userText, activeModelForId);
    if (identityAnswer && !imageBase64) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, identityAnswer);
      return new Response("OK", { status: 200 });
    }
    let typingMessageId = null;
    try {
      const { base_url, api_key } = await getActiveApi(env);
      const EXTERNAL_API_URL = `${base_url}/chat/completions`;
      const AI_MODEL = activeModelForId;
      try {
        const typingRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: "📝Typing..." })
        });
        const typingData = await typingRes.json();
        typingMessageId = typingData?.result?.message_id || null;
      } catch {
      }
      let history = await getChatMemory(env, chatId);
      if (history.length >= 80) {
        const recent = history.slice(-20);
        if (typingMessageId) {
          try {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId, text: "Merangkum.." })
            });
          } catch {
          }
        }
        const summary = await summarizeHistory(env, AI_MODEL, history.slice(0, -20));
        if (summary) {
          history = [...summary, ...recent];
          await saveChatMemory(env, chatId, history);
        } else {
          history = recent;
        }
      }
      const systemPrompt = `Kamu adalah bot Telegram AI bernama "My Assist". Identitas: "aku adalah bot buatan Naufal Alamsyah menggunakan model ${AI_MODEL}". Jika ditanya identitas, jawab persis kalimat tersebut.

PENTING \u2014 GUNAKAN RIWAYAT CHAT: Pesan-pesan sebelum pesan terbaru adalah riwayat percakapan yang BISA kamu baca. Gunakan konteks itu saat menjawab. Jika user bertanya "tadi kita ngomong apa", "lanjutkan", "ingat?" atau merujuk obrolan sebelumnya, jawab berdasarkan riwayat yang tersedia, JANGAN mengaku tidak ingat selama konteksnya ada di riwayat.

GAYA JAWABAN: Jawab SEPENDEK-PENDEKNYA dan langsung ke inti. Untuk pertanyaan sederhana (ya/tidak, angka, fakta cepat, sapa, "halo"), jawab 1-2 kalimat tanpa basa-basi, tanpa pendahuluan, tanpa penutup. Jangan menjelaskan proses berpikirmu. Hanya perjelas bila diminta.

Kamu memiliki akses tool yang bisa kamu panggil saat dibutuhkan:
- websearch: cari informasi dari web untuk pertanyaan faktual/terkini
- get_current_time: cek waktu sekarang
- list_projects, storage_status, cleanup_recommendations: cek info project/storage
- list_models, switch_model: kelola model AI
- newproject: buat project baru (HANYA eksekusi jika user mengonfirmasi dengan jelas)
- purge_project: hapus project dari D1 (HANYA eksekusi jika user mengonfirmasi dengan jelas)

Gunakan tool secara aktif saat dibutuhkan. Jangan menjawab "aku tidak tahu" untuk pertanyaan yang bisa dijawab dengan tool.`;

      let currentUserContent;
      if (imageBase64) {
        currentUserContent = [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ];
      } else {
        currentUserContent = userText;
      }

      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: currentUserContent }
      ];

      let finalContent = "";
      let iterations = 0;
      while (iterations < MAX_TOOL_ITERATIONS) {
        const controller = new AbortController();
        const aiTimeout = setTimeout(() => controller.abort(), 6e4);
        let externalRes;
        try {
          externalRes = await fetch(EXTERNAL_API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${api_key}`
            },
            body: JSON.stringify({
              model: AI_MODEL,
              messages,
              tools: TOOL_DEFINITIONS,
              max_tokens: 500
            }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(aiTimeout);
        }
        if (!externalRes.ok) throw new Error(`AI API error: ${externalRes.status}`);
        const aiData = await externalRes.json();
        const choice = aiData.choices?.[0];
        if (!choice) throw new Error("AI response empty");
        const message = choice.message;
        if (message.tool_calls?.length > 0) {
          messages.push(message);
          for (const tc of message.tool_calls) {
            const result = await executeTool(tc, env, chatId, fromId);
            messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          }
          iterations++;
          continue;
        }
        finalContent = message.content || "Maaf, tidak ada respons.";
        break;
      }
      if (!finalContent) finalContent = "Maaf, terlalu banyak iterasi tool. Coba jelaskan lebih spesifik.";
      if (typingMessageId) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId })
          });
        } catch {
        }
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, String(finalContent).trim().slice(0, 4096));
      
      const historyUserText = imageBase64 ? `${userText}\n[Gambar dilampirkan]` : userText;
      history = [
        ...history, 
        { role: "user", content: historyUserText }, 
        { role: "assistant", content: String(finalContent).trim() }
      ];
      await saveChatMemory(env, chatId, history);
    } catch (err) {
      console.error(err);
      if (typingMessageId) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId })
          });
        } catch {
        }
      }
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `System Error: ${err.message}`);
      } catch {
      }
    }
    return new Response("OK", { status: 200 });
  }
};
var MAX_TOOL_ITERATIONS = 5;
var TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "websearch",
      description: "Cari informasi dari web. Gunakan untuk pertanyaan yang membutuhkan informasi terkini, berita, atau fakta dari internet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Kata kunci pencarian" }
        },
        required: ["query"]
      }
    }
  },
  {
  type: "function",
  function: {
    name: "bulk_delete_github_repos",
    description: "Hapus beberapa repositori dari GitHub secara massal berdasarkan daftar nama. HANYA eksekusi jika user mengonfirmasi dengan jelas.",
    parameters: {
      type: "object",
      properties: {
        repo_names: {
          type: "array",
          items: { type: "string" },
          description: "Daftar nama lengkap repositori yang akan dihapus (contoh: ['username/repo1', 'username/repo2'])"
        }
      },
      required: ["repo_names"]
    }
  }
},
  {
    type: "function",
    function: {
      name: "set_repo_visibility",
      description: "Ubah status visibilitas repositori GitHub antara private atau public.",
      parameters: {
        type: "object",
        properties: {
          repo_name: { type: "string", description: "Nama lengkap repositori (contoh: username/nama-repo)" },
          private: { type: "boolean", description: "True untuk private, false untuk public" }
        },
        required: ["repo_name", "private"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "commit_and_push",
      description: "Commit dan push perubahan file baru ke repositori GitHub yang sudah ada.",
      parameters: {
        type: "object",
        properties: {
          repo_name: { type: "string", description: "Nama lengkap repositori (contoh: username/nama-repo)" },
          commit_message: { type: "string", description: "Pesan commit" },
          file_path: { type: "string", description: "Path file yang akan diubah/ditambahkan (contoh: src/index.js)" },
          file_content: { type: "string", description: "Isi konten file yang baru" }
        },
        required: ["repo_name", "commit_message", "file_path", "file_content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "commit_and_push",
      description: "Commit dan push perubahan file baru ke repositori GitHub yang sudah ada.",
      parameters: {
        type: "object",
        properties: {
          repo_name: { type: "string", description: "Nama lengkap repositori (contoh: username/nama-repo)" },
          commit_message: { type: "string", description: "Pesan commit" },
          file_path: { type: "string", description: "Path file yang akan diubah/ditambahkan (contoh: src/index.js)" },
          file_content: { type: "string", description: "Isi konten file yang baru" }
        },
        required: ["repo_name", "commit_message", "file_path", "file_content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_github_repo",
      description: 'Hapus repositori dari GitHub. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya, hapus repo pemilik/nama-repo").',
      parameters: {
        type: "object",
        properties: {
          repo_name: { type: "string", description: "Nama lengkap repositori (contoh: username/nama-repo)" }
        },
        required: ["repo_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_github_repos",
      description: "Tampilkan daftar repositori GitHub milik user yang tersambung.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Dapatkan waktu dan tanggal sekarang (UTC dan WIB).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "check_github_auth",
      description: "Cek status autentikasi GitHub user (apakah PAT tersimpan dan valid serta menampilkan username GitHub).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "Tampilkan daftar project milik user saat ini dari D1.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "storage_status",
      description: "Cek status penggunaan storage D1 (terpakai vs kuota).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "cleanup_recommendations",
      description: "Dapatkan rekomendasi project mana yang sebaiknya dihapus (FILO). Hanya membaca, tidak menghapus.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_models",
      description: "Tampilkan semua model AI yang tersedia dari Geraikita.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_model",
      description: "Ganti model AI untuk sesi/room ini.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "ID model yang dipilih" }
        },
        required: ["model"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "newproject",
      description: 'HAPUS ATAU JANGAN DIPANGGIL OTOMATIS jika user mengetik command manual.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama project (huruf kecil, angka, strip)" },
          template: {
            type: "string",
            enum: ["custom-project","worker-hello", "worker-api", "ai-chat"],
            description: "Template scaffold"
          }
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "purge_project",
      description: 'Hapus project dari D1. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya, hapus project X"). Repo GitHub tidak dihapus.',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama project yang akan dihapus" }
        },
        required: ["name"]
      }
    }
  }
];
async function executeTool(toolCall, env, chatId, fromId) {
  const name = toolCall.function?.name;
  let args;
  try {
    args = JSON.parse(toolCall.function?.arguments || "{}");
  } catch {
    return "Error: invalid tool arguments";
  }
  try {
    switch (name) {
      case "websearch":
        return await toolWebsearch(args.query);
      case "get_current_time": {
        const now = /* @__PURE__ */ new Date();
        const utc = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
        const wib = new Date(now.getTime() + 7 * 36e5);
        const wibStr = wib.toISOString().replace("T", " ").slice(0, 19) + " WIB";
        const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
        const day = days[wib.getUTCDay()];
        const date = wib.toISOString().slice(0, 10);
        return `Waktu sekarang: ${day}, ${date} ${wibStr}\n(UTC: ${utc})`;
      }
      case "bulk_delete_github_repos": {
     const repoNames = args.repo_names || [];
     if (!Array.isArray(repoNames) || repoNames.length === 0) return "Daftar nama repositori kosong.";
     if (!env.DB) return "D1 tidak tersedia.";
     const pat = await getServiceToken(env, fromId, "github");
     if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";

     let successCount = 0;
     let failCount = 0;
     const details = [];

     for (const repoName of repoNames) {
       try {
         const res = await fetch(`https://api.github.com/repos/${repoName}`, {
           method: "DELETE",
           headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
         });
         if (res.status === 204) {
           successCount++;
           details.push(`- ${repoName}: Berhasil dihapus`);
         } else {
           failCount++;
           const data = await res.json().catch(() => ({}));
           details.push(`- ${repoName}: Gagal (${data?.message || res.status})`);
         }
       } catch (err) {
         failCount++;
         details.push(`- ${repoName}: Error (${err.message})`);
       }
     }

     return `Bulk delete selesai.\nBerhasil: ${successCount}\nGagal: ${failCount}\n\nDetail:\n${details.join("\n")}`;
   }
      case "set_repo_visibility": {
        const repoName = args.repo_name || "";
        const isPrivate = Boolean(args.private);
        if (!repoName) return "Nama repositori wajib diisi.";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const res = await fetch(`https://api.github.com/repos/${repoName}`, {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "User-Agent": "telegram-ai-bot"
            },
            body: JSON.stringify({ private: isPrivate })
          });
          const data = await res.json();
          if (!res.ok) return `Gagal mengubah visibilitas: ${data?.message || res.status}`;
          return `Visibilitas repositori "${repoName}" berhasil diubah menjadi ${isPrivate ? "private" : "public"}.`;
        } catch (err) {
          return `Error saat mengubah visibilitas repo: ${err.message}`;
        }
      }
      case "delete_github_repo": {
        const repoName = args.repo_name || "";
        if (!repoName) return "Nama repositori tidak boleh kosong.";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const res = await fetch(`https://api.github.com/repos/${repoName}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot"
            }
          });
          if (res.status === 204) {
            return `Repositori "${repoName}" berhasil dihapus dari GitHub.`;
          }
          const data = await res.json().catch(() => ({}));
          return `Gagal menghapus repo: ${data?.message || res.status}`;
        } catch (err) {
          return `Error saat menghapus repo GitHub: ${err.message}`;
        }
      }
      case "list_commits": {
        const repoName = args.repo_name || "";
        if (!repoName) return "Nama repositori wajib diisi.";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const res = await fetch(`https://api.github.com/repos/${repoName}/commits?per_page=10`, {
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot"
            }
          });
          if (!res.ok) return "Gagal mengambil daftar commit dari GitHub.";
          const commits = await res.json();
          if (!Array.isArray(commits) || commits.length === 0) return "Belum ada commit di repo ini.";
          return commits.map((c) => `- [${c.sha.slice(0, 7)}] ${c.commit.message.split("\n")[0]} (${c.commit.author.name})`).join("\n");
        } catch (err) {
          return `Error saat mengambil daftar commit: ${err.message}`;
        }
      }
      case "commit_and_push": {
        const repoName = args.repo_name || "";
        const commitMessage = args.commit_message || "Update via bot";
        const filePath = args.file_path || "";
        const fileContent = args.file_content || "";
        if (!repoName || !filePath) return "Nama repo dan path file wajib diisi.";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const headers = {
            Authorization: `Bearer ${pat}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "telegram-ai-bot"
          };
          const base = `https://api.github.com/repos/${repoName}`;
          
          // 1. Get default branch & latest commit sha
          const refRes = await fetch(`${base}/git/ref/heads/main`, { headers });
          if (!refRes.ok) return "Gagal mengambil referensi branch main.";
          const refData = await refRes.json();
          const latestCommitSha = refData.object.sha;

          const commitRes = await fetch(`${base}/git/commits/${latestCommitSha}`, { headers });
          if (!commitRes.ok) return "Gagal mengambil commit terakhir.";
          const commitData = await commitRes.json();
          const baseTreeSha = commitData.tree.sha;

          // 2. Create blob
          const blobRes = await fetch(`${base}/git/blobs`, {
            method: "POST",
            headers,
            body: JSON.stringify({ content: fileContent, encoding: "utf-8" })
          });
          if (!blobRes.ok) return "Gagal membuat git blob.";
          const blobData = await blobRes.json();

          // 3. Create tree
          const treeRes = await fetch(`${base}/git/trees`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              base_tree: baseTreeSha,
              tree: [{ path: filePath, mode: "100644", type: "blob", sha: blobData.sha }]
            })
          });
          if (!treeRes.ok) return "Gagal membuat git tree.";
          const treeData = await treeRes.json();

          // 4. Create new commit
          const newCommitRes = await fetch(`${base}/git/commits`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              message: commitMessage,
              tree: treeData.sha,
              parents: [latestCommitSha]
            })
          });
          if (!newCommitRes.ok) return "Gagal membuat commit baru.";
          const newCommitData = await newCommitRes.json();

          // 5. Update ref
          const updateRefRes = await fetch(`${base}/git/refs/heads/main`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ sha: newCommitData.sha, force: false })
          });
          if (!updateRefRes.ok) return "Gagal push pembaruan ke branch main.";

          return `Berhasil commit & push file "${filePath}" ke ${repoName}.`;
        } catch (err) {
          return `Error saat commit & push: ${err.message}`;
        }
      }
      case "list_github_repos": {
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const res = await fetch("https://api.github.com/user/repos?per_page=30&sort=updated", {
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot"
            }
          });
          if (!res.ok) return "Gagal mengambil daftar repositori dari GitHub.";
          const repos = await res.json();
          if (!Array.isArray(repos) || repos.length === 0) return "Belum ada repositori.";
          return repos.map((r) => `- ${r.full_name} (${r.private ? "private" : "public"})`).join("\n");
        } catch {
          return "Error saat mengambil daftar repo GitHub.";
        }
      }
      case "check_github_auth": {
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tersimpan tetapi tidak valid atau sudah expired.";
        return `GitHub tersambung sebagai @${githubLogin}.`;
      }
      case "list_projects": {
        if (!env.DB) return "D1 tidak tersedia.";
        const rows = await env.DB.prepare(
          "SELECT name, total_bytes, created_at, github_repo FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25"
        ).bind(String(fromId)).all();
        const list = (rows.results || []).map((p) => `- ${p.name} (${fmtBytes(p.total_bytes)}) \u2192 ${p.github_repo}`).join("\n");
        return list || "Belum ada project.";
      }
      case "storage_status": {
        if (!env.DB) return "D1 tidak tersedia.";
        const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
        const usage = await getStorageUsage(env);
        return `Storage: ${fmtBytes(usage)} / ${fmtBytes(quota)} (${(usage / quota * 100).toFixed(1)}%)`;
      }
      case "cleanup_recommendations": {
        if (!env.DB) return "D1 tidak tersedia.";
        const rows = await env.DB.prepare(
          "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10"
        ).all();
        const rec = (rows.results || []).map((p, i) => `#${i + 1} ${p.name} \u2014 ${fmtBytes(p.total_bytes)} \u2014 dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`).join("\n");
        return rec || "Tidak ada project untuk dibersihkan.";
      }
      case "list_models": {
        const models = await fetchModelList(env);
        if (!models) return "Gagal memuat daftar model.";
        return models.map((m) => `${m.id} (${m.vendor})`).join("\n");
      }
      case "switch_model": {
        const model = args.model;
        if (!model) return "Model tidak boleh kosong.";
        const modelList = await fetchModelList(env);
        const exists = modelList ? modelList.some((m) => m.id === model) : FALLBACK_MODELS.includes(model);
        if (!exists) return `Model "${model}" tidak dikenal. Gunakan /models untuk melihat daftar.`;
        await setActiveModel(env, chatId, model);
        return `Model sesi ini diganti ke: ${model}`;
      }
case "newproject": {
        const projName = (args.name || "").toLowerCase();
        const template = args.template || "worker-hello";
        if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(projName))
          return "Format nama tidak valid (3-50 karakter, huruf kecil/angka/strip).";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        const files = renderTemplate(template, projName);
        if (!files) return "Template tidak dikenal.";
        const totalBytes = files.reduce((s, f) => s + f.size, 0);
        const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
        const usage = await getStorageUsage(env);
        if (usage + totalBytes > quota * 0.95) return `Storage hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Hapus dulu project lain.`;

        try {
          let repo;
          try {
            repo = await createGithubRepo(pat, projName);
          } catch (createErr) {
            const checkRes = await fetch(`https://api.github.com/repos/${githubLogin}/${projName}`, {
              headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
            });
            if (checkRes.ok) {
              repo = await checkRes.json();
            } else {
              throw createErr;
            }
          }

          // Coba push file, tangkap jika error karena repo kosong/sudah ada isinya
          try {
            await pushFilesToGithub(pat, repo.full_name, files);
          } catch (pushErr) {
            if (!pushErr.message.includes("empty") && !pushErr.message.includes("exists")) {
              throw pushErr;
            }
          }

          const now = Date.now();
          await env.DB.prepare("INSERT OR IGNORE INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(projName, String(fromId), repo.full_name, totalBytes, now, now).run();
          
          const projRow = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
          if (projRow) {
            await env.DB.batch(files.map((f) => env.DB.prepare("INSERT OR IGNORE INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(projRow.id, f.path, f.content, f.size)));
          }

          // Verifikasi senyap via list/get repo ke GitHub
          const verifyRes = await fetch(`https://api.github.com/repos/${repo.full_name}`, {
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
          });

          if (verifyRes.ok) {
            return `Repository dan project "${projName}" sudah berhasil dibuat.\nURL: https://github.com/${repo.full_name}\nFile: ${files.length} (${fmtBytes(totalBytes)})`;
          } else {
            return `Project "${projName}" berhasil dibuat di GitHub.`;
          }
        } catch (err) {
          if (err.message && (err.message.includes("name already exists") || err.message.includes("Repository creation failed") || err.message.includes("empty"))) {
            return `Project "${projName}" sudah berhasil dibuat di GitHub.`;
          }
          return `Pembuatan project ${projName} gagal: ${err.message}`;
        }
      }
      case "purge_project": {
        const projName = (args.name || "").toLowerCase();
        if (!projName) return "Nama project tidak boleh kosong.";
        if (!env.DB) return "D1 tidak tersedia.";
        const row = await env.DB.prepare("SELECT id FROM projects WHERE name = ? AND owner_id = ?").bind(projName, String(fromId)).first();
        if (!row) return `Project "${projName}" tidak ditemukan.`;
        await env.DB.batch([env.DB.prepare("DELETE FROM project_files WHERE project_id = ?").bind(row.id), env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id)]);
        return `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`;
      }
      default:
        return `Tool "${name}" tidak dikenal.`;
    }
  } catch (err) {
    console.error(`Tool ${name} error:`, err.message);
    return `Error saat menjalankan ${name}: ${err.message}`;
  }
}
__name(executeTool, "executeTool");
async function toolWebsearch(query) {
  if (!query) return "Query tidak boleh kosong.";
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "telegram-ai-bot/1.0" } }
    );
    if (!res.ok) return "Gagal mengakses DuckDuckGo.";
    const data = await res.json();
    const parts = [];
    if (data.Abstract) parts.push(data.Abstract);
    if (data.Answer) parts.push(`Jawaban: ${data.Answer}`);
    if (data.Heading) parts.push(`Topik: ${data.Heading}`);
    const related = (data.RelatedTopics || []).filter((t) => t.Text).slice(0, 5);
    if (related.length) parts.push("Topik terkait:\n" + related.map((t) => `- ${t.Text}`).join("\n"));
    if (data.Infobox?.content) {
      const info = data.Infobox.content.slice(0, 5).map((c) => `- ${c.label}: ${c.value}`).join("\n");
      if (info) parts.push(info);
    }
    return parts.length ? parts.join("\n\n") : `Tidak ada hasil untuk "${query}". Coba kata kunci lain.`;
  } catch {
    return "Error saat mencari di web.";
  }
}
__name(toolWebsearch, "toolWebsearch");
function canonicalIdentityAnswer(text, model) {
  const norm = (text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const botRef = /\b(kamu|kau|anda|lu|lo|bot|u)\b/.test(norm);
  if (!botRef) return null;
  const identityWords = [
    "siapa",
    "pembuat",
    "pencipta",
    "pemilik",
    "owner",
    "developer",
    "dibuat",
    "membuat",
    "bikinan",
    "bikin",
    "buatan",
    "ciptaan",
    "model",
    "nama",
    "tentang",
    "profil",
    "identitas",
    "who are you",
    "who made",
    "who created",
    "who built",
    "who owns",
    "created by",
    "your creator",
    "your model",
    "your name",
    "your owner",
    "made by",
    "built by"
  ];
  const hasIdentity = identityWords.some((w) => norm.includes(w));
  if (!hasIdentity) return null;
  return `aku adalah bot buatan Naufal Alamsyah menggunakan model ${model}`;
}
__name(canonicalIdentityAnswer, "canonicalIdentityAnswer");
var FALLBACK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "claude-sonnet-5", "gpt-5.6-sol"];
var VENDOR_LABEL = {
  Anthropic: "Anthropic (Claude)",
  OpenAI: "OpenAI (GPT)",
  "Moonshot AI": "Moonshot (Kimi)",
  "Zhipu AI": "Zhipu (GLM)",
  DeepSeek: "DeepSeek",
  Qwen: "Qwen"
};
async function getActiveModel(env, chatId) {
  const fallback = env.AI_MODEL || "deepseek-v4-flash";
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare("SELECT model FROM chat_settings WHERE chat_id = ?").bind(String(chatId)).first();
    return row?.model || fallback;
  } catch {
    return fallback;
  }
}
__name(getActiveModel, "getActiveModel");
async function setActiveModel(env, chatId, model) {
  await env.DB.prepare("INSERT OR REPLACE INTO chat_settings (chat_id, model, updated_at) VALUES (?, ?, ?)").bind(String(chatId), model, Date.now()).run();
}
__name(setActiveModel, "setActiveModel");
var DEFAULT_API_BASE = "https://ai.geraikita.com/v1";
async function getApiConfig(env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare("SELECT base_url, api_key FROM api_config WHERE id = ?").bind("active").first();
    return row ? { base_url: row.base_url, api_key: row.api_key } : null;
  } catch {
    return null;
  }
}
__name(getApiConfig, "getApiConfig");
async function setApiConfig(env, base_url, api_key) {
  await env.DB.prepare("INSERT OR REPLACE INTO api_config (id, base_url, api_key, updated_at) VALUES (?, ?, ?, ?)").bind("active", base_url, api_key, Date.now()).run();
}
__name(setApiConfig, "setApiConfig");
async function setApiBase(env, base_url) {
  const existing = await getApiConfig(env);
  const api_key = existing?.api_key || env.EXTERNAL_API_KEY || "";
  await setApiConfig(env, base_url, api_key);
}
__name(setApiBase, "setApiBase");
async function setApiKey(env, api_key) {
  const existing = await getApiConfig(env);
  const base_url = existing?.base_url || DEFAULT_API_BASE;
  await setApiConfig(env, base_url, api_key);
}
__name(setApiKey, "setApiKey");
async function clearApiConfig(env) {
  if (!env.DB) return;
  await env.DB.prepare("DELETE FROM api_config WHERE id = ?").bind("active").run();
}
__name(clearApiConfig, "clearApiConfig");
async function getActiveApi(env) {
  const config = await getApiConfig(env);
  return config ? { base_url: config.base_url, api_key: config.api_key } : { base_url: DEFAULT_API_BASE, api_key: env.EXTERNAL_API_KEY };
}
__name(getActiveApi, "getActiveApi");
function maskApiKey(key) {
  if (!key || key.length < 12) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}
__name(maskApiKey, "maskApiKey");
async function fetchModelList(env) {
  try {
    const { base_url, api_key } = await getActiveApi(env);
    const res = await fetch(`${base_url}/models`, {
      headers: { Authorization: `Bearer ${api_key}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.data) || data.data.length === 0) return null;
    return data.data.filter((m) => typeof m?.id === "string" && m.id.length > 0).map((m) => ({ id: m.id, vendor: m.owned_by || "Lainnya" }));
  } catch {
    return null;
  }
}
__name(fetchModelList, "fetchModelList");
async function formatModelList(env) {
  let models = await fetchModelList(env);
  if (!models) {
    models = FALLBACK_MODELS.map((id) => ({ id, vendor: "Lainnya" }));
  }
  const byVendor = {};
  for (const m of models) {
    const label = VENDOR_LABEL[m.vendor] || m.vendor;
    (byVendor[label] ||= []).push(m.id);
  }
  const lines = [];
  for (const vendor of Object.keys(byVendor).sort()) {
    lines.push(`\u2014 ${vendor} \u2014`);
    for (const id of byVendor[vendor].sort()) lines.push(`  ${id}`);
  }
  return lines.join("\n");
}
__name(formatModelList, "formatModelList");
var SUMMARY_MAX_CHARS = 6e3;
async function getChatMemory(env, chatId) {
  if (!env.DB) return [];
  try {
    const row = await env.DB.prepare("SELECT history FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).first();
    if (!row?.history) return [];
    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
__name(getChatMemory, "getChatMemory");
async function saveChatMemory(env, chatId, history) {
  if (!env.DB) return;
  try {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO chat_memory (chat_id, history, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).bind(String(chatId), JSON.stringify(history), now, now).run();
  } catch (err) {
    console.error("saveChatMemory failed:", err.message);
  }
}
__name(saveChatMemory, "saveChatMemory");
async function summarizeHistory(env, model, history) {
  try {
    const { base_url, api_key } = await getActiveApi(env);
    
    // Berikan AbortController agar jika perangkuman macet lebih dari 30 detik, proses langsung dibatalkan
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let res;
    try {
      res = await fetch(`${base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${api_key}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Kamu adalah perangkum percakapan yang teliti. Buat ringkasan singkat, padat, dan pertahankan konteks penting dalam Bahasa Indonesia. Maksimal 2000 karakter." },
            ...history
          ],
          max_tokens: 1000 // Diturunkan sedikit dari 2000 agar tidak terlalu berat/lama
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    const trimmed = text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!trimmed) return null;
    return [{ role: "system", content: `Ringkasan percakapan sebelumnya:\n${trimmed}` }];
  } catch (err) {
    console.error("summarizeHistory error:", err.message);
    return null; // Jika gagal/stuck, kembalikan null agar bot tidak crash dan langsung pakai 20 pesan terakhir saja
  }
}
__name(summarizeHistory, "summarizeHistory");
async function getStorageUsage(env) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare("SELECT SUM(total_bytes) AS s FROM projects").first();
  return Number(row?.s || 0);
}
__name(getStorageUsage, "getStorageUsage");
function fmtBytes(n) {
  if (!Number.isFinite(n)) n = 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
__name(fmtBytes, "fmtBytes");
function renderTemplate(tpl, repoName) {
  const files = [];
  const put = /* @__PURE__ */ __name((path, content) => files.push({ path, content, size: new TextEncoder().encode(content).length }), "put");
  if (tpl === "worker-hello") {
    put("wrangler.toml", `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n`);
    put("src/index.js", `/**\n * ${repoName}: Hello World Worker\n * ES Modules + native fetch.\n */\nexport default {\n  async fetch(request, env, ctx) {\n    if (request.method !== 'GET') {\n      return new Response('Method Not Allowed', { status: 405 });\n    }\n    return new Response('Hello World from ${repoName}!', { status: 200 });\n  },\n};\n`);
    put("package.json", `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "worker-api") {
    put("wrangler.toml", `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n`);
    put("src/index.js", `/**\n * ${repoName}: JSON API Worker\n */\nexport default {\n  async fetch(request, env, ctx) {\n    const url = new URL(request.url);\n    if (url.pathname === '/api/hello' && request.method === 'GET') {\n      return Response.json({ message: 'hello', project: '${repoName}', time: Date.now() });\n    }\n    if (url.pathname === '/api/echo' && request.method === 'POST') {\n      const body = await request.json().catch(() => ({}));\n      return Response.json({ echo: body });\n    }\n    return Response.json({ error: 'not found' }, { status: 404 });\n  },\n};\n`);
    put("package.json", `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "ai-chat") {
    put("wrangler.toml", `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${repoName}"\ndatabase_id = "CHANGE_ME"\n`);
    put("src/index.js", `/**\n * ${repoName}: AI Chat (openai-compatible)\n * Ganti baseURL + model + apiKey lewat env/secret.\n */\nexport default {\n  async fetch(request, env, ctx) {\n    if (request.method !== 'POST') return new Response('OK', { status: 200 });\n    const body = await request.json().catch(() => ({}));\n    const text = body?.message?.text || body?.text;\n    if (!text) return new Response('OK', { status: 200 });\n    const url = env.AI_URL || 'https://ai.geraikita.com/v1/chat/completions';\n    const res = await fetch(url, {\n      method: 'POST',\n      headers: {\n        'Content-Type': 'application/json',\n        Authorization: \`Bearer \${env.AI_KEY}\`,\n      },\n      body: JSON.stringify({\n        model: env.AI_MODEL || 'deepseek-v4-flash',\n        messages: [{ role: 'user', content: text }],\n      }),\n    });\n    const data = await res.json();\n    const reply = data?.choices?.[0]?.message?.content || 'no reply';\n    return Response.json({ reply });\n  },\n};\n`);
    put("package.json", `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
} else if (tpl === "custom-project") {
    put("README.md", `# ${repoName}\n\nCustom project.\n\n## Getting Started\n\n1. Install dependencies:\n   \`\`\`bash\n   npm install\n   \`\`\`\n\n2. Run project:\n   \`\`\`bash\n   npm start\n   \`\`\`\n`);
    put("package.json", `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "start": "node index.js"\n  }\n}\n`);
    put("index.js", `console.log("Hello from ${repoName}!");\n`);
    put(".gitignore", "node_modules/\n");
  } else {
    return null;
  }
  return files;
}
__name(renderTemplate, "renderTemplate");
async function createGithubRepo(pat, name) {
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "telegram-ai-bot"
    },
    body: JSON.stringify({
      name,
      description: "Generated by Naufal-Telegram-Bot",
      private: true,
      auto_init: false,
      has_wiki: false
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `GitHub create repo error: ${res.status}`);
  return data;
}
__name(createGithubRepo, "createGithubRepo");
async function pushFilesToGithub(pat, fullName, files) {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "telegram-ai-bot"
  };
  const base = `https://api.github.com/repos/${fullName}`;
  const blobs = [];
  for (const f of files) {
    const r = await fetch(`${base}/git/blobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: f.content, encoding: "utf-8" })
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b?.message || "git blob error");
    blobs.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
  }
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tree: blobs })
  });
  const tree = await treeRes.json();
  if (!treeRes.ok) throw new Error(tree?.message || "git tree error");
  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: `Initial scaffold via telegram-ai-bot`,
      tree: tree.sha,
      parents: []
    })
  });
  const commit = await commitRes.json();
  if (!commitRes.ok) throw new Error(commit?.message || "git commit error");
  const refRes = await fetch(`${base}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha })
  });
  return refRes.ok;
}
__name(pushFilesToGithub, "pushFilesToGithub");
async function getServiceToken(env, fromId, service) {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT token FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), service).first();
  return row?.token || null;
}
__name(getServiceToken, "getServiceToken");
async function validateGithubToken(pat) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "telegram-ai-bot"
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.login || null;
  } catch {
    return null;
  }
}
__name(validateGithubToken, "validateGithubToken");
async function validateSupabaseToken(pat) {
  try {
    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` }
    });
    return res.ok;
  } catch {
    return false;
  }
}
__name(validateSupabaseToken, "validateSupabaseToken");
async function listSupabaseProjects(pat) {
  try {
    const res = await fetch("https://api.supabase.com/v1/projects", {
      headers: { Authorization: `Bearer ${pat}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((p) => `- ${p.name || p.id}`).slice(0, 50);
  } catch {
    return null;
  }
}
__name(listSupabaseProjects, "listSupabaseProjects");
async function getTelegramImageBase64(env, file_id) {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id })
    });
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) return null;

    const imgRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
    if (!imgRes.ok) return null;
    const buf = await imgRes.arrayBuffer();
    return arrayBufferToBase64(buf);
  } catch (err) {
    console.error("Gagal fetch gambar:", err);
    return null;
  }
}
__name(getTelegramImageBase64, "getTelegramImageBase64");
async function transcribeVoiceNote(env, voiceInfo, chatId) {
  try {
    if (voiceInfo.duration > 60) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Voice terlalu panjang (maks 60 detik).");
      return null;
    }
    if (voiceInfo.file_size > 20 * 1024 * 1024) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Voice terlalu besar (maks 20MB).");
      return null;
    }
    if (!env.AUDIO_TRANSCRIBE && (!env.AUDIO_URL || !env.AUDIO_SECRET)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Audio transcriber belum dikonfigurasi.");
      return null;
    }
    await sendChatAction(env.TELEGRAM_TOKEN, chatId);
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: voiceInfo.file_id })
      }
    );
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengambil file voice.");
      return null;
    }
    const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
    if (!audioRes.ok) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mengunduh voice.");
      return null;
    }
    const audioBuf = await audioRes.arrayBuffer();
    const contentType = audioRes.headers.get("content-type") || "audio/ogg";
    let transcribeRes;
    const audioHeaders = {
      "Content-Type": "application/json",
      ...env.AUDIO_SECRET ? { "X-Audio-Secret": env.AUDIO_SECRET } : {}
    };
    if (env.AUDIO_TRANSCRIBE) {
      transcribeRes = await env.AUDIO_TRANSCRIBE.fetch("https://audio-transcribe/transcribe", {
        method: "POST",
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType })
      });
    } else {
      transcribeRes = await fetch(`${env.AUDIO_URL}/transcribe`, {
        method: "POST",
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType })
      });
    }
    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok || !transcribeData?.text) {
      console.error("Transcribe error:", JSON.stringify(transcribeData).slice(0, 300));
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Gagal mentranskripsi voice.");
      return null;
    }
    return String(transcribeData.text).trim();
  } catch (err) {
    console.error("transcribeVoiceNote error:", err.message);
    try {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Terjadi error saat proses voice.");
    } catch {
    }
    return null;
  }
}
__name(transcribeVoiceNote, "transcribeVoiceNote");
function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
__name(arrayBufferToBase64, "arrayBufferToBase64");
async function sendChatAction(botToken, chat_id) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, action: "typing" })
    });
  } catch {
  }
}
__name(sendChatAction, "sendChatAction");
async function deleteTelegramMessage(botToken, chat_id, message_id) {
  if (!message_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, message_id })
    });
  } catch {
  }
}
__name(deleteTelegramMessage, "deleteTelegramMessage");
function markdownToHtml(text) {
  if (!text) return "";
  let s = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const protectedBlocks = [];
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/`([^`]+)`/g, (m, code) => {
    protectedBlocks.push(`<code>${code}</code>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = convertMarkdownTables(s);
  s = s.replace(/^#{1,4}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^#{1,4}([^#\s].*)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/\*([^*]+)\*/g, "<i>$1</i>");
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => protectedBlocks[Number(i)] || m);
  return s;
}
__name(markdownToHtml, "markdownToHtml");
function convertMarkdownTables(s) {
  const lines = s.split("\n");
  const out = [];
  let i = 0;
  const isSepRow = /* @__PURE__ */ __name((line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line), "isSepRow");
  const isTableRow = /* @__PURE__ */ __name((line) => /^\s*\|.*\|\s*$/.test(line.trim()) || line.trim().startsWith("|"), "isTableRow");
  while (i < lines.length) {
    const line = lines[i];
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const rows = [splitPipeRow(line)];
      i++;
      i++;
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitPipeRow(lines[i]));
        i++;
      }
      out.push(formatTableMonospace(rows));
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}
__name(convertMarkdownTables, "convertMarkdownTables");
function splitPipeRow(line) {
  let l = line.trim();
  l = l.replace(/^\|/, "").replace(/\|$/, "");
  return l.split("|").map((c) => c.trim());
}
__name(splitPipeRow, "splitPipeRow");
function formatTableMonospace(rows) {
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    widths.push(Math.max(...rows.map((r) => (r[c] || "").length)));
  }
  const header = rows[0];
  const body = rows.slice(1);
  const fmt = /* @__PURE__ */ __name((cells) => cells.map((cell, c) => String(cell || "").padEnd(widths[c], " ")).join(" | ").replace(/\s+$/, ""), "fmt");
  const lines = [];
  lines.push(fmt(header.map((c, idx) => `**${c}**`)));
  for (const r of body) lines.push(fmt(r));
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}
__name(formatTableMonospace, "formatTableMonospace");
async function sendTelegram(botToken, chat_id, text) {
  const html = markdownToHtml(text);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}
__name(sendTelegram, "sendTelegram");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
