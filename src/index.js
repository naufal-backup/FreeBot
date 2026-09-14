/**
 * Serverless AI Telegram Chatbot - Cloudflare Worker
 * ES Modules, native fetch() only, no npm packages, no DB.
 *
 * Required secrets (via `wrangler secret put`):
 *   - TELEGRAM_TOKEN (dari @BotFather)
 *   - EXTERNAL_API_KEY (isi dengan apiKey geraikita dari opencode.jsonc, contoh: gk-...)
 *   - ALLOWED_USER_IDS (comma-separated Telegram user ID yang boleh pakai, contoh: 123456789)
 *     Cara dapat ID: kirim /myid ke bot.
 * D1 binding (via wrangler.toml):
 *   - DB -> telegram-projects (tabel: projects, project_files, service_tokens)
 *     Token GitHub/Supabase disimpan per-owner di service_tokens, hapus via /logout-gh / /logout-sb.
 *   - STORAGE_QUOTA_BYTES: default 400MB (80% warning, 95% block)
 * Optional vars:
 *   - AI_MODEL (default: deepseek-v4-flash, pilihan lain di opencode.jsonc:
 *     claude-sonnet-5, gpt-5.6-sol, deepseek-v4-pro)
 *     Untuk pertanyaan identitas, bot selalu menjawab:
 *     "aku adalah bot buatan Naufal Alamsyah menggunakan model {AI_MODEL}"
 */

// Antrean per chat: serialisasi pemrosesan AI agar tidak bertumpuk.
const chatQueues = new Map();

function enqueueChatTask(chatId, task) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(task, task);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

export default {
  async fetch(request, env, ctx) {
    // Kunci endpoint: hanya Telegram webhook yang boleh masuk.
    // Wajib POST + header X-Telegram-Bot-Api-Secret-Token cocok dengan WEBHOOK_SECRET.
    // Semua akses lain (browser GET, POST tanpa/ salah token) ditolak 403.
    // Dengan setWebhook(secret_token=WEBHOOK_SECRET), tidak ada pintu masuk lain ke
    // Worker ini, sehingga D1 & semua operasi hanya bisa dipicu lewat bot.
    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (request.method !== 'POST' || !env.WEBHOOK_SECRET || secretToken !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    // 1. Parse JSON securely. Malformed body -> 200 to stop Telegram retries.
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('OK', { status: 200 });
    }

    // 2. Guard: ignore non-text updates (sticker, photo, edited_message, etc.)
    const chatId = update?.message?.chat?.id;
    const voiceInfo = update?.message?.voice;
    let userText = update?.message?.text;
    const fromId = update?.message?.from?.id;
    const messageId = update?.message?.message_id;
    if (!chatId || !fromId) {
      return new Response('OK', { status: 200 });
    }

    // 2a. Voice note: transkripsi dulu jadi teks (tanpa simpan file permanen).
    if (!userText && voiceInfo) {
      const transcribed = await transcribeVoiceNote(env, voiceInfo, chatId);
      if (transcribed === null) {
        return new Response('OK', { status: 200 });
      }
      userText = transcribed;
      if (!userText) {
        return new Response('OK', { status: 200 });
      }
    } else if (!userText) {
      // Sticker/foto/dll → abaikan, jangan retry
      return new Response('OK', { status: 200 });
    }

    // Normalisasi perintah: Telegram menu pakai underscore (/login_gh),
    // ketik manual pakai hyphen (/login-gh). Keduanya diterima.
    const cmdWord = userText.split(/\s+/)[0].replace(/_/g, '-');
    const cmdArg = userText.includes(' ') ? userText.slice(userText.indexOf(' ') + 1).trim() : '';

    // Public helper: /myid selalu dibalas agar owner bisa tahu ID-nya
    // tanpa perlu @userinfobot. Aman: hanya membalas ID milik pengirim sendiri.
    if (cmdWord === '/myid') {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Your ID: ${fromId}`);
      return new Response('OK', { status: 200 });
    }

    // 2b. Restriction: hanya ALLOWED_USER_IDS yang boleh pakai.
    // Jika secret belum di-set, tolak semua demi aman (fail-closed) agar kuota tidak bocor.
    const allowed = (env.ALLOWED_USER_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(String(fromId))) {
      console.log(`Blocked unauthorized user: ${fromId}`);
      return new Response('OK', { status: 200 });
    }

    // Optional: answer /start locally without spending AI quota
    if (cmdWord === '/start') {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Halo! Kirim pesan apa saja, saya balas dengan AI.\n\nKetik /help untuk daftar perintah.');
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/help') {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        'Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model sesi\n/models - daftar model\n/reset - hapus memori chat sesi\n/myid - lihat Telegram ID kamu\n' +
          '/newproject <nama> [template] - buat project (worker-hello|worker-api|ai-chat) + repo GitHub\n/projects - list project\n/storage - status D1\n/cleanup - rekomendasi hapus (FILO)\n/purge <nama> yes - hapus dari D1\n' +
          '/need-supabase <nama> - buat project Supabase\n' +
          '/login-gh /token-gh <pat> /gh-status /logout-gh - kelola GitHub\n' +
          '/login-sb /token-sb <pat> /sb-status /logout-sb - kelola Supabase\n' +
          '/changeapi <url> <key> - ganti API sekaligus (provider + key)\n/changeprovider <url> - ganti provider, key tetap\n/changekey <key> - ganti key, provider tetap\n/api-status - lihat API aktif\n/resetapi - kembali ke default\n\nKetik teks bebas untuk chat AI.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/model') {
      const activeModel = await getActiveModel(env, chatId);
      const target = cmdArg.split(/\s+/)[0];
      if (!target) {
        const list = await formatModelList(env);
        const modelList = list ? `\n\nModel tersedia (live /v1/models):\n${list}` : '\n\n(daftar model gagal dimuat)';
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model aktif sesi ini: ${activeModel}\nGanti: /model <nama>.${modelList}`);
        return new Response('OK', { status: 200 });
      }
      // switch: validasi ke daftar live
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const models = await fetchModelList(env);
      const exists = models ? models.some((m) => m.id === target) : FALLBACK_MODELS.includes(target);
      if (!exists) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model "${target}" tidak dikenal. Gunakan /model untuk melihat daftar.`);
        return new Response('OK', { status: 200 });
      }
      await setActiveModel(env, chatId, target);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model sesi ini diganti ke: ${target}`);
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/models') {
      const activeModel = await getActiveModel(env, chatId);
      const list = await formatModelList(env);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        list ? `Model aktif: ${activeModel}\n\nDaftar model (live /v1/models):\n${list}` : 'Gagal memuat daftar model dari Geraikita. Coba lagi nanti.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/reset') {
      if (env.DB) {
        await env.DB.prepare('DELETE FROM chat_memory WHERE chat_id = ?').bind(String(chatId)).run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Memori chat sesi ini dihapus. Konteks sebelumnya tidak lagi diingat.');
      return new Response('OK', { status: 200 });
    }

    // --- Token layanan murni-bot (GitHub / Supabase), tanpa laptop ---
    if (cmdWord === '/login-gh') {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        'Sambung GitHub:\n1. Buka github.com/settings/tokens (Fine-grained, expiry ≤7 hari, scope Contents read-write untuk repo target)\n2. Copy token\n3. Kirim ke sini: /token-gh <token>\nPesan token langsung saya hapus setelah dibaca.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/token-gh') {
      const pat = cmdArg.split(/\s+/)[0] || '';
      if (pat.length < 20) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /token-gh <token>. Token terlalu pendek, cek lagi.');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi. Hubungi admin.');
        return new Response('OK', { status: 200 });
      }
      const login = await validateGithubToken(pat);
      if (!login) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Token GitHub tidak valid. Buat baru lalu kirim ulang.');
        return new Response('OK', { status: 200 });
      }
      await env.DB.prepare(
        'INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(String(fromId), 'github', pat, Date.now())
        .run();
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `GitHub tersambung sebagai @${login}. Pesan token sudah dihapus.`);
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/gh-status') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi. Hubungi admin.');
        return new Response('OK', { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, 'github');
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'GitHub belum tersambung. Kirim /login-gh dulu.');
        return new Response('OK', { status: 200 });
      }
      const login = await validateGithubToken(pat);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        login ? `GitHub tersambung sebagai @${login}.` : 'Token GitHub tersimpan tapi tidak valid lagi. Kirim /token-gh baru atau /logout-gh.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/logout-gh') {
      if (env.DB) {
        await env.DB.prepare('DELETE FROM service_tokens WHERE owner_id = ? AND service = ?')
          .bind(String(fromId), 'github')
          .run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Token GitHub dihapus dari bot. Revoke juga di github.com/settings/tokens.');
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/login-sb') {
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        'Sambung Supabase:\n1. Buka supabase.com/dashboard/account/tokens → Create new token\n2. Copy token (sbp_...)\n3. Kirim ke sini: /token-sb <token>\nPesan token langsung saya hapus setelah dibaca.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/token-sb') {
      const pat = cmdArg.split(/\s+/)[0] || '';
      if (pat.length < 20) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /token-sb <token>. Token terlalu pendek, cek lagi.');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi. Hubungi admin.');
        return new Response('OK', { status: 200 });
      }
      const ok = await validateSupabaseToken(pat);
      if (!ok) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Token Supabase tidak valid. Buat baru lalu kirim ulang.');
        return new Response('OK', { status: 200 });
      }
      await env.DB.prepare(
        'INSERT OR REPLACE INTO service_tokens (owner_id, service, token, created_at) VALUES (?, ?, ?, ?)'
      )
        .bind(String(fromId), 'supabase', pat, Date.now())
        .run();
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Supabase tersambung. Pesan token sudah dihapus. Operasi project (/need-supabase) menyusul.');
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/sb-status') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi. Hubungi admin.');
        return new Response('OK', { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, 'supabase');
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Supabase belum tersambung. Kirim /login-sb dulu.');
        return new Response('OK', { status: 200 });
      }
      const names = await listSupabaseProjects(pat);
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        names === null
          ? 'Token Supabase tersimpan tapi tidak valid lagi. Kirim /token-sb baru atau /logout-sb.'
          : names.length === 0
            ? 'Supabase tersambung. Belum ada project.'
            : `Supabase tersambung. Projects (${names.length}):\n${names.slice(0, 10).join('\n')}`
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/logout-sb') {
      if (env.DB) {
        await env.DB.prepare('DELETE FROM service_tokens WHERE owner_id = ? AND service = ?')
          .bind(String(fromId), 'supabase')
          .run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Token Supabase dihapus dari bot. Revoke juga di dashboard Supabase.');
      return new Response('OK', { status: 200 });
    }

    // --- API config: /changeapi /api-status /resetapi ---
    if (cmdWord === '/changeapi') {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const baseUrl = args[0] || '';
      const apiKey = args.slice(1).join(' ') || '';
      if (!baseUrl || !apiKey) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /changeapi <base_url> <api_key>\nContoh: /changeapi https://api.kelontongai.id/v1 sk-xxx...');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 tidak tersedia.');
        return new Response('OK', { status: 200 });
      }
      // Validasi: panggil /models dengan key baru
      try {
        const testRes = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API tidak valid (HTTP ${testRes.status}). Cek base_url dan key.`);
          return new Response('OK', { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke API: ${err.message}`);
        return new Response('OK', { status: 200 });
      }
      await setApiConfig(env, baseUrl, apiKey);
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API diganti ke: ${baseUrl}\n(Simpan, pesan key dihapus.)`);
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/changeprovider') {
      const baseUrl = (cmdArg.trim() || '').replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseUrl)) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /changeprovider <base_url>\nContoh: /changeprovider https://api.kelontongai.id/v1\n(Key tetap dipertahankan.)');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 tidak tersedia.');
        return new Response('OK', { status: 200 });
      }
      const existing = await getApiConfig(env);
      const apiKey = existing?.api_key || env.EXTERNAL_API_KEY || '';
      try {
        const testRes = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider tidak valid (HTTP ${testRes.status}). Cek base_url & key aktif.`);
          return new Response('OK', { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi ke provider: ${err.message}`);
        return new Response('OK', { status: 200 });
      }
      await setApiBase(env, baseUrl);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider diganti ke: ${baseUrl}\nKey tetap: ${maskApiKey(apiKey)}`);
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/changekey') {
      const apiKey = cmdArg.split(/\s+/)[0] || '';
      if (apiKey.length < 10) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /changekey <api_key>\nKey terlalu pendek. Contoh: /changekey sk-xxx...');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 tidak tersedia.');
        return new Response('OK', { status: 200 });
      }
      const existing = await getApiConfig(env);
      const base_url = existing?.base_url || DEFAULT_API_BASE;
      try {
        const testRes = await fetch(`${base_url}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!testRes.ok) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key tidak valid untuk ${base_url} (HTTP ${testRes.status}).`);
          return new Response('OK', { status: 200 });
        }
      } catch (err) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal koneksi: ${err.message}`);
        return new Response('OK', { status: 200 });
      }
      await setApiKey(env, apiKey);
      await deleteTelegramMessage(env.TELEGRAM_TOKEN, chatId, messageId);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Key API diganti (provider: ${base_url}). Pesan key dihapus.`);
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/api-status') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 tidak tersedia.');
        return new Response('OK', { status: 200 });
      }
      const config = await getApiConfig(env);
      if (config) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API aktif: ${config.base_url}\nKey: ${maskApiKey(config.api_key)}\n\n/resetapi untuk kembali ke default.`);
      } else {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API default: ${DEFAULT_API_BASE}\nGunakan /changeapi untuk ganti.`);
      }
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/resetapi') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 tidak tersedia.');
        return new Response('OK', { status: 200 });
      }
      await clearApiConfig(env);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API dikembalikan ke default: ${DEFAULT_API_BASE}`);
      return new Response('OK', { status: 200 });
    }

    // --- Project management: /newproject /projects /storage /cleanup /purge ---
    if (cmdWord === '/newproject') {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const projName = (args[0] || '').toLowerCase();
      const template = (args[1] || 'worker-hello').toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(projName)) {
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          'Format: /newproject <nama> [template]\nnama: huruf kecil, angka, strip; 3-50 karakter.\nTemplate: worker-hello | worker-api | ai-chat'
        );
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi. Hubungi admin.');
        return new Response('OK', { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, 'github');
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'GitHub belum tersambung. Kirim /login-gh dulu.');
        return new Response('OK', { status: 200 });
      }
      const githubLogin = await validateGithubToken(pat);
      if (!githubLogin) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Token GitHub tidak valid. Kirim /token-gh baru lalu ulangi.');
        return new Response('OK', { status: 200 });
      }

      const files = renderTemplate(template, projName);
      if (!files) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Template tidak dikenal: gunakan worker-hello, worker-api, atau ai-chat.');
        return new Response('OK', { status: 200 });
      }
      const totalBytes = files.reduce((s, f) => s + f.size, 0);

      // Cek kuota storage (D1) sebelum create
      const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
      const usage = await getStorageUsage(env);
      if (usage + totalBytes > quota * 0.95) {
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Storage D1 hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Kirim /cleanup untuk melihat rekomendasi hapus, atau /storage.`
        );
        return new Response('OK', { status: 200 });
      }

      // Cek duplikat nama milik user sendiri
      const dup = await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind(projName).first();
      if (dup) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" sudah ada (termasuk punya user lain). Pilih nama lain.`);
        return new Response('OK', { status: 200 });
      }

      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Membuat project "${projName}" (${template})...`);
        const repo = await createGithubRepo(pat, projName);
        const fullName = repo.full_name;
        const pushed = await pushFilesToGithub(pat, fullName, files);
        if (!pushed) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Repo ${fullName} dibuat tapi push file gagal. Coba /purge lalu ulangi.`);
          return new Response('OK', { status: 200 });
        }
        const now = Date.now();
        await env.DB.prepare(
          'INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
          .bind(projName, String(fromId), fullName, totalBytes, now, now)
          .run();
        const projRow = await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind(projName).first();
        await env.DB.batch(
          files.map((f) =>
            env.DB.prepare('INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)')
              .bind(projRow.id, f.path, f.content, f.size)
          )
        );
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Project jadi: ${fullName}\nFile: ${files.length} (${fmtBytes(totalBytes)})\n` +
            `Repo: https://github.com/${fullName}\nSimpanan: ${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}`
        );
      } catch (err) {
        console.error(err);
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat project: ${err.message}`);
      }
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/projects') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const rows = await env.DB.prepare(
        'SELECT name, github_repo, total_bytes, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25'
      )
        .bind(String(fromId))
        .all();
      const list = (rows.results || [])
        .map((p) => `- ${p.name} · ${fmtBytes(p.total_bytes)} · ${new Date(p.created_at).toISOString().slice(0, 10)} (${p.github_repo})`)
        .join('\n');
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? `Projects (${rows.results.length}):\n${list}` : 'Belum ada project. Ketik /newproject <nama> [template].');
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/storage') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
      const usage = await getStorageUsage(env);
      const rows = await env.DB.prepare(
        'SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC LIMIT 10'
      ).all();
      const filo = (rows.results || [])
        .map((p, i) => `#${i + 1} ${p.name} · ${fmtBytes(p.total_bytes)} · dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`)
        .join('\n');
      await sendTelegram(
        env.TELEGRAM_TOKEN,
chatId,
        'Storage D1: ' + fmtBytes(usage) + ' / ' + fmtBytes(quota) + ' (' + ((usage / quota) * 100).toFixed(1) + '%)\n\nUrutan hapus FILO (terbaru dulu):\n' + (filo || '(kosong)') + '\n\n/cleanup untuk rekomendasi, /purge <nama> [yes] untuk hapus.',
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/cleanup') {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const rows = await env.DB.prepare(
        'SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10'
      ).all();
      const rec = (rows.results || [])
        .map((p, i) => `#${i + 1} ${p.name} · ${fmtBytes(p.total_bytes)} · akses terakhir ${new Date(p.last_accessed_at || p.created_at).toISOString().slice(0, 10)}`)
        .join('\n');
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        (rec ? `Rekomendasi hapus (FILO terbaru dulu):\n${rec}\n\nKonfirmasi: /purge <nama> yes` : 'Tidak ada project untuk dibersihkan.') +
          '\nCatatan: hapus hanya dari D1, repo GitHub tetap aman.'
      );
      return new Response('OK', { status: 200 });
    }

    if (cmdWord === '/purge') {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const projName = args[0] || '';
      const yes = args[1] === 'yes';
      if (!yes) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Yakin hapus "${projName}" dari D1? Balas: /purge ${projName} yes\n(Repo GitHub tidak dihapus.)`);
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const row = await env.DB.prepare('SELECT id FROM projects WHERE name = ? AND owner_id = ?')
        .bind(projName, String(fromId))
        .first();
      if (!row) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" tidak ditemukan milikmu.`);
        return new Response('OK', { status: 200 });
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM project_files WHERE project_id = ?').bind(row.id),
        env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(row.id),
      ]);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`);
      return new Response('OK', { status: 200 });
    }

    // --- Supabase: /need-supabase <nama> (create project via Management API) ---
    if (cmdWord === '/need-supabase') {
      const projName = (cmdArg.split(/\s+/)[0] || '').toLowerCase();
      if (!/^[a-z][a-z0-9-]{2,23}$/.test(projName)) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Format: /need-supabase <nama>\nnama: huruf kecil, angka, strip; 3-24 karakter.');
        return new Response('OK', { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'D1 belum dikonfigurasi.');
        return new Response('OK', { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, 'supabase');
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Supabase belum tersambung. Kirim /login-sb dulu.');
        return new Response('OK', { status: 200 });
      }
      try {
        const orgs = await fetch('https://api.supabase.com/v1/organizations', {
          headers: { Authorization: `Bearer ${pat}` },
        });
        if (!orgs.ok) throw new Error('Organisasi Supabase tidak valid.');
        const orgList = await orgs.json();
        const orgId = (Array.isArray(orgList) ? orgList[0]?.id : null) || '';
        if (!orgId) throw new Error('Akun Supabase belum punya organisasi.');
        const createRes = await fetch('https://api.supabase.com/v1/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat}` },
          body: JSON.stringify({
            name: projName,
            organization_id: orgId,
            plan: 'free',
            region: 'ap-southeast-1',
          }),
        });
        const created = await createRes.json();
        if (!createRes.ok) throw new Error(created?.message || 'Gagal create project Supabase.');
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Project Supabase "${projName}" sedang diprovisioning (ref: ${created?.ref || created?.id || '?'}).\nCek status: /sb-status (bisa butuh beberapa menit).`
        );
      } catch (err) {
        console.error(err);
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat Supabase project: ${err.message}`);
      }
      return new Response('OK', { status: 200 });
    }

    // --- Strict identity: deterministik, sebelum AI dipanggil ---
    const activeModelForId = await getActiveModel(env, chatId);
    const identityAnswer = canonicalIdentityAnswer(userText, activeModelForId);
    if (identityAnswer) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, identityAnswer);
      return new Response('OK', { status: 200 });
    }

    try {
      // 3. Send user text to AI (OpenAI-compatible)
      const { base_url, api_key } = await getActiveApi(env);
      const EXTERNAL_API_URL = `${base_url}/chat/completions`;
      const AI_MODEL = activeModelForId;

      // Kirim pesan "Typing..." sebagai indikator visual, lalu hapus saat selesai
      let typingMessageId = null;
      try {
        const typingRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: 'Typing...' }),
        });
        const typingData = await typingRes.json();
        typingMessageId = typingData?.result?.message_id || null;
      } catch {} // best-effort

      let history = await getChatMemory(env, chatId);

      // Auto-rangkum saat >= 80 entri: ringkasan + 20 pesan terbaru tersimpan,
      // agar konteks lama dipertahankan ringkas TAPI konteks baru tidak hilang.
      if (history.length >= 80) {
        const recent = history.slice(-20);
        if (typingMessageId) {
          try {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId, text: 'Merangkum..' }),
            });
          } catch {}
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

PENTING — GUNAKAN RIWAYAT CHAT: Pesan-pesan sebelum pesan terbaru adalah riwayat percakapan yang BISA kamu baca. Gunakan konteks itu saat menjawab. Jika user bertanya "tadi kita ngomong apa", "lanjutkan", "ingat?" atau merujuk obrolan sebelumnya, jawab berdasarkan riwayat yang tersedia, JANGAN mengaku tidak ingat selama konteksnya ada di riwayat.

GAYA JAWABAN: Jawab SEPENDEK-PENDEKNYA dan langsung ke inti. Untuk pertanyaan sederhana (ya/tidak, angka, fakta cepat, sapa, "halo"), jawab 1-2 kalimat tanpa basa-basi, tanpa pendahuluan, tanpa penutup. Jangan menjelaskan proses berpikirmu. Hanya perjelas bila diminta.

Kamu memiliki akses tool yang bisa kamu panggil saat dibutuhkan:
- websearch: cari informasi dari web untuk pertanyaan faktual/terkini
- get_current_time: cek waktu sekarang
- list_projects, storage_status, cleanup_recommendations: cek info project/storage
- list_models, switch_model: kelola model AI
- newproject: buat project baru (HANYA eksekusi jika user mengonfirmasi dengan jelas)
- purge_project: hapus project dari D1 (HANYA eksekusi jika user mengonfirmasi dengan jelas)
- commit_files: commit file ke GitHub. Jika user mengirim KODE (format markdown dengan \`\`\`), langsung commit ke repo project yang sesuai.
- list_repo_files: lihat isi repo/folder GitHub. Panggil saat user minta "lihat isi repo", "file apa aja", "cek repo".
- read_repo_file: baca isi file dari repo GitHub. Panggil saat user minta "lihat isi file", "baca file", "tampilkan".
- delete_repo: hapus repo GitHub secara permanen. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya hapus repo X").

Gunakan tool secara aktif saat dibutuhkan. Jangan menjawab "aku tidak tahu" untuk pertanyaan yang bisa dijawab dengan tool.`;

const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: userText },
      ];

      let finalContent = '';
      let iterations = 0;

      while (iterations < MAX_TOOL_ITERATIONS) {
        const controller = new AbortController();
        const aiTimeout = setTimeout(() => controller.abort(), 60000);
        let externalRes;
        try {
          externalRes = await fetch(EXTERNAL_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${api_key}`,
            },
            body: JSON.stringify({
              model: AI_MODEL,
              messages,
              tools: TOOL_DEFINITIONS,
              max_tokens: 500,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(aiTimeout);
        }

        if (!externalRes.ok) throw new Error(`AI API error: ${externalRes.status}`);

        const aiData = await externalRes.json();
        const choice = aiData.choices?.[0];

        if (!choice) throw new Error('AI response empty');

        const message = choice.message;

        // Ada tool_calls -> eksekusi
        if (message.tool_calls?.length > 0) {
          messages.push(message);
          for (const tc of message.tool_calls) {
            const result = await executeTool(tc, env, chatId, fromId);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          iterations++;
          continue;
        }

        // Tidak ada tool_calls -> selesai
        finalContent = message.content || 'Maaf, tidak ada respons.';
        break;
      }

      if (!finalContent) finalContent = 'Maaf, terlalu banyak iterasi tool. Coba jelaskan lebih spesifik.';

      // Hapus pesan "Typing..." sebelum kirim balasan
      if (typingMessageId) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId }),
          });
        } catch {} // best-effort
      }

      await sendTelegram(env.TELEGRAM_TOKEN, chatId, String(finalContent).trim().slice(0, 4096));

      history = [...history, { role: 'user', content: userText }, { role: 'assistant', content: String(finalContent).trim() }];
      await saveChatMemory(env, chatId, history);
    } catch (err) {
      console.error(err);
      // Hapus "Typing..." jika error, lalu kirim error message
      if (typingMessageId) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId }),
          });
        } catch {}
      }
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Sorry, something went wrong. Try again.');
      } catch {}
    }

    // Always 200 so Telegram does not infinitely retry
    return new Response('OK', { status: 200 });
  },
};

// --- Tool Calling: AI Tools ---

const MAX_TOOL_ITERATIONS = 5;

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'websearch',
      description: 'Cari informasi dari web. Gunakan untuk pertanyaan yang membutuhkan informasi terkini, berita, atau fakta dari internet.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Kata kunci pencarian' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Dapatkan waktu dan tanggal sekarang (UTC dan WIB).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'Tampilkan daftar project milik user saat ini dari D1.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'storage_status',
      description: 'Cek status penggunaan storage D1 (terpakai vs kuota).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cleanup_recommendations',
      description: 'Dapatkan rekomendasi project mana yang sebaiknya dihapus (FILO). Hanya membaca, tidak menghapus.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: 'Tampilkan semua model AI yang tersedia dari Geraikita.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_model',
      description: 'Ganti model AI untuk sesi/room ini.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'ID model yang dipilih' },
        },
        required: ['model'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'newproject',
      description: 'Buat project baru + repo GitHub. HANYA eksekusi jika user mengonfirmasi dengan jelas dalam pesannya (misal: "iya, buatkan" atau "ya, buat project toko-api").',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project (huruf kecil, angka, strip)' },
          template: {
            type: 'string',
            enum: ['worker-hello', 'worker-api', 'ai-chat'],
            description: 'Template scaffold',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'purge_project',
      description: 'Hapus project dari D1. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya, hapus project X"). Repo GitHub tidak dihapus.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nama project yang akan dihapus' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_files',
      description: 'Commit file ke repo GitHub yang sudah ada. HANYA eksekusi jika user mengonfirmasi dengan jelas atau mengirim kode yang mau di-commit.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Full name repo (owner/repo)' },
          message: { type: 'string', description: 'Pesan commit' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Path file' },
                content: { type: 'string', description: 'Isi file' },
              },
              required: ['path', 'content'],
            },
          },
        },
        required: ['repo', 'message', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_repo_files',
      description: 'Lihat daftar file di repo GitHub. Hasilnya daftar path file.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Full name repo (owner/repo)' },
          path: { type: 'string', description: 'Path subfolder (kosong utk root)' },
        },
        required: ['repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_repo_file',
      description: 'Baca isi file dari repo GitHub.',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Full name repo (owner/repo)' },
          path: { type: 'string', description: 'Path file (src/index.js)' },
        },
        required: ['repo', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_repo',
      description: 'Hapus repo GitHub secara permanen. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya, hapus repo X").',
      parameters: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Full name repo (owner/repo)' },
        },
        required: ['repo'],
      },
    },
  },
];

/**
 * Eksekusi tool call dari AI. Return string hasil tool.
 */
async function executeTool(toolCall, env, chatId, fromId) {
  const name = toolCall.function?.name;
  let args;
  try {
    args = JSON.parse(toolCall.function?.arguments || '{}');
  } catch {
    return 'Error: invalid tool arguments';
  }

  try {
    switch (name) {
      case 'websearch':
        return await toolWebsearch(args.query);

      case 'get_current_time': {
        const now = new Date();
        const utc = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        const wib = new Date(now.getTime() + 7 * 3600000);
        const wibStr = wib.toISOString().replace('T', ' ').slice(0, 19) + ' WIB';
        const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        const day = days[wib.getUTCDay()];
        const date = wib.toISOString().slice(0, 10);
        return `Waktu sekarang: ${day}, ${date} ${wibStr}\n(UTC: ${utc})`;
      }

      case 'list_projects': {
        if (!env.DB) return 'D1 tidak tersedia.';
        const rows = await env.DB.prepare(
          'SELECT name, total_bytes, created_at, github_repo FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25'
        )
          .bind(String(fromId))
          .all();
        const list = (rows.results || [])
          .map((p) => `- ${p.name} (${fmtBytes(p.total_bytes)}) → ${p.github_repo}`)
          .join('\n');
        return list || 'Belum ada project.';
      }

      case 'storage_status': {
        if (!env.DB) return 'D1 tidak tersedia.';
        const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
        const usage = await getStorageUsage(env);
        return `Storage: ${fmtBytes(usage)} / ${fmtBytes(quota)} (${((usage / quota) * 100).toFixed(1)}%)`;
      }

      case 'cleanup_recommendations': {
        if (!env.DB) return 'D1 tidak tersedia.';
        const rows = await env.DB.prepare(
          'SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10'
        ).all();
        const rec = (rows.results || [])
          .map((p, i) => `#${i + 1} ${p.name} — ${fmtBytes(p.total_bytes)} — dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`)
          .join('\n');
        return rec || 'Tidak ada project untuk dibersihkan.';
      }

      case 'list_models': {
        const models = await fetchModelList(env);
        if (!models) return 'Gagal memuat daftar model.';
        return models.map((m) => `${m.id} (${m.vendor})`).join('\n');
      }

      case 'switch_model': {
        const model = args.model;
        if (!model) return 'Model tidak boleh kosong.';
        const modelList = await fetchModelList(env);
        const exists = modelList ? modelList.some((m) => m.id === model) : FALLBACK_MODELS.includes(model);
        if (!exists) return `Model "${model}" tidak dikenal. Gunakan /models untuk melihat daftar.`;
        await setActiveModel(env, chatId, model);
        return `Model sesi ini diganti ke: ${model}`;
      }

      case 'newproject': {
        const projName = (args.name || '').toLowerCase();
        const template = args.template || 'worker-hello';
        if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(projName))
          return 'Format nama tidak valid (3-50 karakter, huruf kecil/angka/strip).';
        if (!env.DB) return 'D1 tidak tersedia.';
        const pat = await getServiceToken(env, fromId, 'github');
        if (!pat) return 'GitHub belum tersambung. Gunakan /login-gh dulu.';
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return 'Token GitHub tidak valid.';
        const files = renderTemplate(template, projName);
        if (!files) return 'Template tidak dikenal.';
        const totalBytes = files.reduce((s, f) => s + f.size, 0);
        const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
        const usage = await getStorageUsage(env);
        if (usage + totalBytes > quota * 0.95) return `Storage hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Hapus dulu project lain.`;
        const dup = await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind(projName).first();
        if (dup) return `Project "${projName}" sudah ada.`;
        const repo = await createGithubRepo(pat, projName);
        await pushFilesToGithub(pat, repo.full_name, files);
        const now = Date.now();
        await env.DB.prepare('INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)').bind(projName, String(fromId), repo.full_name, totalBytes, now, now).run();
        const projRow = await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind(projName).first();
        await env.DB.batch(files.map((f) => env.DB.prepare('INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)').bind(projRow.id, f.path, f.content, f.size)));
        return `Project "${projName}" dibuat: https://github.com/${repo.full_name}\nFile: ${files.length} (${fmtBytes(totalBytes)})`;
      }

      case 'purge_project': {
        const projName = (args.name || '').toLowerCase();
        if (!projName) return 'Nama project tidak boleh kosong.';
        if (!env.DB) return 'D1 tidak tersedia.';
        const row = await env.DB.prepare('SELECT id FROM projects WHERE name = ? AND owner_id = ?').bind(projName, String(fromId)).first();
        if (!row) return `Project "${projName}" tidak ditemukan.`;
        await env.DB.batch([env.DB.prepare('DELETE FROM project_files WHERE project_id = ?').bind(row.id), env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(row.id)]);
        return `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`;
      }

      case 'commit_files': {
        const repo = args.repo;
        const message = args.message || 'Update via telegram-ai-bot';
        const files = args.files;
        if (!repo || !Array.isArray(files) || files.length === 0) return 'repo dan files (array) harus diisi.';
        if (!env.DB) return 'D1 tidak tersedia.';
        const pat = await getServiceToken(env, fromId, 'github');
        if (!pat) return 'GitHub belum tersambung. Gunakan /login-gh dulu.';
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return 'Token GitHub tidak valid.';
        await commitToRepo(pat, repo, message, files, 'main');
        // Update project_files di D1 untuk repo yang sesuai
        const proj = await env.DB.prepare('SELECT id FROM projects WHERE owner_id = ? AND github_repo = ?').bind(String(fromId), repo).first();
        if (proj) {
          for (const f of files) {
            const sz = new TextEncoder().encode(f.content || '').length;
            await env.DB.prepare('INSERT OR REPLACE INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)').bind(proj.id, f.path, f.content || '', sz).run();
          }
          const total = await getStorageUsage(env);
          await env.DB.prepare('UPDATE projects SET total_bytes = (SELECT COALESCE(SUM(size),0) FROM project_files WHERE project_id=?), last_accessed_at = ? WHERE id = ?').bind(proj.id, Date.now(), proj.id).run();
        }
        return `Commit berhasil ke ${repo} (${files.length} file). Pesan: "${message}"`;
      }

      case 'list_repo_files': {
        const repo = args.repo;
        const folderPath = args.path || '';
        if (!repo) return 'repo harus diisi.';
        const pat = await getServiceToken(env, fromId, 'github');
        if (!pat) return 'GitHub belum tersambung. Gunakan /login-gh dulu.';
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return 'Token GitHub tidak valid.';
        const files = await listRepoContents(pat, repo, folderPath);
        if (files === null) return `Gagal membaca repo ${repo}.`;
        if (files.length === 0) return `Repo ${repo} kosong di path "${folderPath}".`;
        return files.map((f) => `${f.type === 'dir' ? '[folder]' : '[file]'} ${f.path} (${f.size > 0 ? Math.round(f.size/1024)+'KB' : '0KB'})`).join('\n');
      }

      case 'read_repo_file': {
        const repo = args.repo;
        const filePath = args.path;
        if (!repo || !filePath) return 'repo dan path harus diisi.';
        const pat = await getServiceToken(env, fromId, 'github');
        if (!pat) return 'GitHub belum tersambung. Gunakan /login-gh dulu.';
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return 'Token GitHub tidak valid.';
        const content = await readRepoFile(pat, repo, filePath);
        if (content === null) return `Gagal membaca file ${filePath} dari ${repo}.`;
        return content;
      }

      case 'delete_repo': {
        const repo = args.repo;
        if (!repo || !repo.includes('/')) return 'repo harus format owner/repo (contoh: naufal-backup/naufal).';
        const pat = await getServiceToken(env, fromId, 'github');
        if (!pat) return 'GitHub belum tersambung. Gunakan /login-gh dulu.';
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return 'Token GitHub tidak valid.';
        try {
          const res = await fetch(`https://api.github.com/repos/${repo}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'telegram-ai-bot' },
          });
          if (!res.ok && res.status !== 204) {
            const errData = await res.json().catch(() => ({}));
            return `Gagal hapus repo ${repo}: ${errData?.message || res.status}`;
          }
          // Juga hapus dari D1 jika ada
          const proj = await env.DB.prepare('SELECT id FROM projects WHERE owner_id = ? AND github_repo = ?').bind(String(fromId), repo).first();
          if (proj) {
            await env.DB.batch([
              env.DB.prepare('DELETE FROM project_files WHERE project_id = ?').bind(proj.id),
              env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(proj.id),
            ]);
          }
          return `Repo ${repo} berhasil dihapus dari GitHub.`;
        } catch (err) {
          return `Error hapus repo: ${err.message}`;
        }
      }

      default:
        return `Tool "${name}" tidak dikenal.`;
    }
  } catch (err) {
    console.error(`Tool ${name} error:`, err.message);
    return `Error saat menjalankan ${name}: ${err.message}`;
  }
}

/**
 * Web search via DuckDuckGo Instant Answer API (gratis, tanpa key).
 */
async function toolWebsearch(query) {
  if (!query) return 'Query tidak boleh kosong.';
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { 'User-Agent': 'telegram-ai-bot/1.0' } }
    );
    if (!res.ok) return 'Gagal mengakses DuckDuckGo.';
    const data = await res.json();
    const parts = [];
    if (data.Abstract) parts.push(data.Abstract);
    if (data.Answer) parts.push(`Jawaban: ${data.Answer}`);
    if (data.Heading) parts.push(`Topik: ${data.Heading}`);
    const related = (data.RelatedTopics || []).filter((t) => t.Text).slice(0, 5);
    if (related.length) parts.push('Topik terkait:\n' + related.map((t) => `- ${t.Text}`).join('\n'));
    if (data.Infobox?.content) {
      const info = data.Infobox.content.slice(0, 5).map((c) => `- ${c.label}: ${c.value}`).join('\n');
      if (info) parts.push(info);
    }
    return parts.length ? parts.join('\n\n') : `Tidak ada hasil untuk "${query}". Coba kata kunci lain.`;
  } catch {
    return 'Error saat mencari di web.';
  }
}

/**
 * Deteksi pertanyaan identitas secara deterministik (tanpa AI).
 * Return kalimat kanonis jika terdeteksi, atau null.
 * Strict: tidak bisa dimanipulasi karena berjalan sebelum AI dipanggil.
 */
function canonicalIdentityAnswer(text, model) {
  const norm = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const botRef = /\b(kamu|kau|anda|lu|lo|bot|u)\b/.test(norm);
  if (!botRef) return null;

  const identityWords = [
    'siapa', 'pembuat', 'pencipta', 'pemilik', 'owner', 'developer',
    'dibuat', 'membuat', 'bikinan', 'bikin', 'buatan', 'ciptaan',
    'model', 'nama', 'tentang', 'profil', 'identitas',
    'who are you', 'who made', 'who created', 'who built', 'who owns',
    'created by', 'your creator', 'your model', 'your name', 'your owner',
    'made by', 'built by',
  ];
  const hasIdentity = identityWords.some((w) => norm.includes(w));
  if (!hasIdentity) return null;

  return `aku adalah bot buatan Naufal Alamsyah menggunakan model ${model}`;
}

// --- Model per-sesi ---

// Fallback jika fetch /v1/models gagal
const FALLBACK_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'claude-sonnet-5', 'gpt-5.6-sol'];

// Label vendor untuk tampilan Telegram (dari owned_by di /v1/models)
const VENDOR_LABEL = {
  Anthropic: 'Anthropic (Claude)',
  OpenAI: 'OpenAI (GPT)',
  'Moonshot AI': 'Moonshot (Kimi)',
  'Zhipu AI': 'Zhipu (GLM)',
  DeepSeek: 'DeepSeek',
  Qwen: 'Qwen',
};

/**
 * Ambil model aktif untuk room. Prioritas: chat_settings > env.AI_MODEL > default.
 */
async function getActiveModel(env, chatId) {
  const fallback = env.AI_MODEL || 'deepseek-v4-flash';
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare('SELECT model FROM chat_settings WHERE chat_id = ?')
      .bind(String(chatId))
      .first();
    return row?.model || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Simpan model aktif untuk room.
 */
async function setActiveModel(env, chatId, model) {
  await env.DB.prepare('INSERT OR REPLACE INTO chat_settings (chat_id, model, updated_at) VALUES (?, ?, ?)')
    .bind(String(chatId), model, Date.now())
    .run();
}

// --- API Config (global, bukan per-user) ---

const DEFAULT_API_BASE = 'https://ai.geraikita.com/v1';

/**
 * Ambil konfigurasi API aktif dari D1. Return { base_url, api_key } atau null (pakai default).
 */
async function getApiConfig(env) {
  if (!env.DB) return null;
  try {
    const row = await env.DB.prepare('SELECT base_url, api_key FROM api_config WHERE id = ?')
      .bind('active')
      .first();
    return row ? { base_url: row.base_url, api_key: row.api_key } : null;
  } catch {
    return null;
  }
}

/**
 * Simpan konfigurasi API baru.
 */
async function setApiConfig(env, base_url, api_key) {
  await env.DB.prepare('INSERT OR REPLACE INTO api_config (id, base_url, api_key, updated_at) VALUES (?, ?, ?, ?)')
    .bind('active', base_url, api_key, Date.now())
    .run();
}

/**
 * Ubah hanya base_url (provider), pertahankan api_key yang sudah ada.
 * Jika belum ada config, api_key diisi default EXTERNAL_API_KEY agar langsung aktif.
 */
async function setApiBase(env, base_url) {
  const existing = await getApiConfig(env);
  const api_key = existing?.api_key || env.EXTERNAL_API_KEY || '';
  await setApiConfig(env, base_url, api_key);
}

/**
 * Ubah hanya api_key, pertahankan base_url yang sudah ada.
 * Jika belum ada config (pakai default Geraikita), api_key baru diterapkan ke base default.
 */
async function setApiKey(env, api_key) {
  const existing = await getApiConfig(env);
  const base_url = existing?.base_url || DEFAULT_API_BASE;
  await setApiConfig(env, base_url, api_key);
}

/**
 * Hapus konfigurasi API (kembali ke default Geraikita).
 */
async function clearApiConfig(env) {
  if (!env.DB) return;
  await env.DB.prepare('DELETE FROM api_config WHERE id = ?').bind('active').run();
}

/**
 * Ambil base_url + api_key aktif. Prioritas: D1 api_config > default Geraikita.
 */
async function getActiveApi(env) {
  const config = await getApiConfig(env);
  return config
    ? { base_url: config.base_url, api_key: config.api_key }
    : { base_url: DEFAULT_API_BASE, api_key: env.EXTERNAL_API_KEY };
}

/**
 * Mask API key: tampilkan hanya 4 karakter pertama + 4 terakhir.
 */
function maskApiKey(key) {
  if (!key || key.length < 12) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/**
 * Fetch daftar model live dari API aktif.
 * Return array {id, vendor} atau null saat gagal.
 */
async function fetchModelList(env) {
  try {
    const { base_url, api_key } = await getActiveApi(env);
    const res = await fetch(`${base_url}/models`, {
      headers: { Authorization: `Bearer ${api_key}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data?.data) || data.data.length === 0) return null;
    return data.data
      .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
      .map((m) => ({ id: m.id, vendor: m.owned_by || 'Lainnya' }));
  } catch {
    return null;
  }
}

/**
 * Format daftar model terkategori untuk pesan Telegram.
 */
async function formatModelList(env) {
  let models = await fetchModelList(env);
  if (!models) {
    models = FALLBACK_MODELS.map((id) => ({ id, vendor: 'Lainnya' }));
  }
  const byVendor = {};
  for (const m of models) {
    const label = VENDOR_LABEL[m.vendor] || m.vendor;
    (byVendor[label] ||= []).push(m.id);
  }
  const lines = [];
  for (const vendor of Object.keys(byVendor).sort()) {
    lines.push(`— ${vendor} —`);
    for (const id of byVendor[vendor].sort()) lines.push(`  ${id}`);
  }
  return lines.join('\n');
}

// --- Memori chat per room ---

const MEMORY_MAX_ENTRIES = 80;
const SUMMARY_MAX_CHARS = 6000;

/**
 * Ambil history chat untuk room dari D1. Return array [{role,content}].
 */
async function getChatMemory(env, chatId) {
  if (!env.DB) return [];
  try {
    const row = await env.DB.prepare('SELECT history FROM chat_memory WHERE chat_id = ?')
      .bind(String(chatId))
      .first();
    if (!row?.history) return [];
    const parsed = JSON.parse(row.history);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Simpan history chat untuk room (INSERT OR REPLACE).
 */
async function saveChatMemory(env, chatId, history) {
  if (!env.DB) return;
  try {
    const now = Date.now();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO chat_memory (chat_id, history, created_at, updated_at) VALUES (?, ?, ?, ?)'
    )
      .bind(String(chatId), JSON.stringify(history), now, now)
      .run();
  } catch (err) {
    console.error('saveChatMemory failed:', err.message);
  }
}

/**
 * Rangkum history (>=80 entri) jadi 1 pesan system, maks ~6000 char.
 * Return array [{role:'system', content}] atau null saat gagal.
 */
async function summarizeHistory(env, model, history) {
  try {
    const { base_url, api_key } = await getActiveApi(env);
    const res = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${api_key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Kamu adalah perangkum percakapan yang teliti. Dari isi percakapan berikut, hasilkan ringkasan yang MEMPERTAHANKAN KONTEKS penting dengan lengkap, dalam Bahasa Indonesia: (1) topik-topik yang dibahas, (2) fakta yang user sebut (nama, proyek, angka, preferensi), (3) keputusan/kesepakatan, (4) nada dan hubungan. Tulis sebagai poin-poin jelas, jangan buang detail pada 20 pesan terakhir (itu dikelola terpisah). Jangan menambahkan informasi yang tidak ada. Maksimal 6000 karakter.' },
          ...history,
        ],
        max_tokens: 2000,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    const trimmed = text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!trimmed) return null;
    return [{ role: 'system', content: `Ringkasan percakapan sebelumnya:\n${trimmed}` }];
  } catch {
    return null;
  }
}

/**
 * Total bytes semua project di D1. Return 0 jika D1 tidak ada / kosong.
 */
async function getStorageUsage(env) {
  if (!env.DB) return 0;
  const row = await env.DB.prepare('SELECT SUM(total_bytes) AS s FROM projects').first();
  return Number(row?.s || 0);
}

/**
 * Format ukuran byte -> human readable.
 */
function fmtBytes(n) {
  if (!Number.isFinite(n)) n = 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Template scaffold. Return array { path, content, size } atau null bila template tak dikenal.
 */
function renderTemplate(tpl, repoName) {
  const files = [];
  const put = (path, content) => files.push({ path, content, size: new TextEncoder().encode(content).length });
  if (tpl === 'worker-hello') {
    put('wrangler.toml', `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n`);
    put('src/index.js', `/**
 * ${repoName}: Hello World Worker
 * ES Modules + native fetch.
 */
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    return new Response('Hello World from ${repoName}!', { status: 200 });
  },
};
`);
    put('package.json', `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put('.gitignore', '.wrangler/\nnode_modules/\n.dev.vars\n');
  } else if (tpl === 'worker-api') {
    put('wrangler.toml', `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n`);
    put('src/index.js', `/**
 * ${repoName}: JSON API Worker
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hello' && request.method === 'GET') {
      return Response.json({ message: 'hello', project: '${repoName}', time: Date.now() });
    }
    if (url.pathname === '/api/echo' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return Response.json({ echo: body });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
`);
    put('package.json', `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put('.gitignore', '.wrangler/\nnode_modules/\n.dev.vars\n');
  } else if (tpl === 'ai-chat') {
    put('wrangler.toml', `name = "${repoName}"\nmain = "src/index.js"\ncompatibility_date = "2026-09-01"\nworkers_dev = true\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${repoName}"\ndatabase_id = "CHANGE_ME"\n`);
    put('src/index.js', `/**
 * ${repoName}: AI Chat (openai-compatible)
 * Ganti baseURL + model + apiKey lewat env/secret.
 */
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK', { status: 200 });
    const body = await request.json().catch(() => ({}));
    const text = body?.message?.text || body?.text;
    if (!text) return new Response('OK', { status: 200 });
    const url = env.AI_URL || 'https://ai.geraikita.com/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: \`Bearer \${env.AI_KEY}\`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL || 'deepseek-v4-flash',
        messages: [{ role: 'user', content: text }],
      }),
    });
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content || 'no reply';
    return Response.json({ reply });
  },
};
`);
    put('package.json', `{\n  "name": "${repoName}",\n  "version": "0.0.1",\n  "private": true,\n  "type": "module",\n  "scripts": {\n    "dev": "wrangler dev",\n    "deploy": "wrangler deploy"\n  }\n}\n`);
    put('.gitignore', '.wrangler/\nnode_modules/\n.dev.vars\n');
  } else {
    return null;
  }
  return files;
}

/**
 * Buat repo GitHub baru (private) milik pemegang token. Return data repo.
 */
async function createGithubRepo(pat, name) {
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'telegram-ai-bot',
    },
    body: JSON.stringify({
      name,
      description: 'Generated by telegram-ai-bot',
      private: true,
      auto_init: false,
      has_wiki: false,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `GitHub create repo error: ${res.status}`);
  return data;
}

/**
 * Push file ke repo GitHub via Git Data API (blob -> tree -> commit -> refs).
 * Return true sukses.
 */
async function pushFilesToGithub(pat, fullName, files) {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'telegram-ai-bot',
  };
  const base = `https://api.github.com/repos/${fullName}`;

  const blobs = [];
  for (const f of files) {
    const r = await fetch(`${base}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b?.message || 'git blob error');
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
  }

  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tree: blobs }),
  });
  const tree = await treeRes.json();
  if (!treeRes.ok) throw new Error(tree?.message || 'git tree error');

  const commitRes = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: `Initial scaffold via telegram-ai-bot`,
      tree: tree.sha,
      parents: [],
    }),
  });
  const commit = await commitRes.json();
  if (!commitRes.ok) throw new Error(commit?.message || 'git commit error');

  const refRes = await fetch(`${base}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
  });
  return refRes.ok;
}

/**
 * Commit file ke repo GitHub yang sudah ada (pakai Git Data API).
 * Ambil head SHA dari branch, buat blobs → tree → commit → update ref.
 */
async function commitToRepo(pat, fullName, message, files, branch = 'main') {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'telegram-ai-bot',
  };
  const base = `https://api.github.com/repos/${fullName}`;

  // 1. Dapatkan SHA commit terbaru di branch
  const refRes = await fetch(`${base}/git/refs/heads/${branch}`, { headers });
  const refData = await refRes.json();
  if (!refRes.ok) throw new Error(refData?.message || 'gagal ambil branch ref');
  const parentSha = refData?.object?.sha;
  if (!parentSha) throw new Error('branch tidak punya commit');

  // 2. Buat blobs untuk setiap file
  const blobs = [];
  for (const f of files) {
    const r = await fetch(`${base}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: f.content, encoding: 'utf-8' }),
    });
    const b = await r.json();
    if (!r.ok) throw new Error(b?.message || 'git blob error');
    blobs.push({ path: f.path, mode: '100644', type: 'blob', sha: b.sha });
  }

  // 3. Buat tree baru dengan parent
  const treeRes = await fetch(`${base}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tree: blobs, base_tree: refData?.object?.tree_sha }), // gunakan tree asli untuk merge
  });
  const tree = await treeRes.json();
  if (!treeRes.ok) throw new Error(tree?.message || 'git tree error');

  // 4. Buat commit dengan parent
  const commitRes = await fetch(`${base}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  const commit = await commitRes.json();
  if (!commitRes.ok) throw new Error(commit?.message || 'git commit error');

  // 5. Update ref branch ke commit baru
  const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  if (!updateRes.ok) {
    const errData = await updateRes.json().catch(() => ({}));
    throw new Error(errData?.message || 'git update ref error');
  }
}

/**
 * Daftar isi folder/repo GitHub via REST API.
 * Return array [{path, type, size}] atau null saat gagal.
 */
async function listRepoContents(pat, repo, folderPath) {
  if (!folderPath) folderPath = '';
  const url = folderPath
    ? `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(folderPath)}`
    : `https://api.github.com/repos/${repo}/contents`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'telegram-ai-bot' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.map((f) => ({
      path: f.path,
      type: f.type || 'file',
      size: f.size || 0,
    }));
  } catch {
    return null;
  }
}

/**
 * Baca isi file dari GitHub repo (base64 decode).
 * Return string content atau null saat gagal.
 */
async function readRepoFile(pat, repo, filePath) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'User-Agent': 'telegram-ai-bot' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.content) return null;
    return atob(data.content.replace(/\s/g, ''));
  } catch {
    return null;
  }
}

/**
 * Ambil token layanan milik owner dari D1. Return string token atau null.
 * Nilai token tidak pernah di-log.
 */
async function getServiceToken(env, fromId, service) {
  if (!env.DB) return null;
  const row = await env.DB.prepare('SELECT token FROM service_tokens WHERE owner_id = ? AND service = ?')
    .bind(String(fromId), service)
    .first();
  return row?.token || null;
}

/**
 * Validasi PAT GitHub via GET /user. Return login atau null.
 */
async function validateGithubToken(pat) {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'telegram-ai-bot',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.login || null;
  } catch {
    return null;
  }
}

/**
 * Validasi Supabase PAT via Management API. Return true/false.
 */
async function validateSupabaseToken(pat) {
  try {
    const res = await fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${pat}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List nama project Supabase. Return array nama atau null jika token invalid.
 */
async function listSupabaseProjects(pat) {
  try {
    const res = await fetch('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${pat}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((p) => `- ${p.name || p.id}`).slice(0, 50);
  } catch {
    return null;
  }
}

/**
 * Transkripsi voice note via audio worker (service binding atau HTTP fallback).
 * Return teks transkrip, atau null jika gagal/ditolak (jangan retry).
 * File audio TIDAK pernah disimpan permanen — dipegang byte array sementara saja.
 */
async function transcribeVoiceNote(env, voiceInfo, chatId) {
  try {
    // Limiter: durasi & ukuran
    if (voiceInfo.duration > 60) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Voice terlalu panjang (maks 60 detik).');
      return null;
    }
    if (voiceInfo.file_size > 20 * 1024 * 1024) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Voice terlalu besar (maks 20MB).');
      return null;
    }
    if (!env.AUDIO_TRANSCRIBE && (!env.AUDIO_URL || !env.AUDIO_SECRET)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Audio transcriber belum dikonfigurasi.');
      return null;
    }

    await sendChatAction(env.TELEGRAM_TOKEN, chatId);

    // 1. getFile → file_path
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: voiceInfo.file_id }),
      }
    );
    const fileData = await fileRes.json();
    const filePath = fileData?.result?.file_path;
    if (!filePath) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Gagal mengambil file voice.');
      return null;
    }

    // 2. download audio dari Telegram (hanya di RAM sementara)
    const audioRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
    if (!audioRes.ok) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Gagal mengunduh voice.');
      return null;
    }
    const audioBuf = await audioRes.arrayBuffer();
    const contentType = audioRes.headers.get('content-type') || 'audio/ogg';

    // 3. panggil audio transcriber
    let transcribeRes;
    const audioHeaders = {
      'Content-Type': 'application/json',
      ...(env.AUDIO_SECRET ? { 'X-Audio-Secret': env.AUDIO_SECRET } : {}),
    };
    if (env.AUDIO_TRANSCRIBE) {
      // Service binding — privat, cepat
      transcribeRes = await env.AUDIO_TRANSCRIBE.fetch('https://audio-transcribe/transcribe', {
        method: 'POST',
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType }),
      });
    } else {
      // Fallback HTTP publik
      transcribeRes = await fetch(`${env.AUDIO_URL}/transcribe`, {
        method: 'POST',
        headers: audioHeaders,
        body: JSON.stringify({ audio: arrayBufferToBase64(audioBuf), contentType }),
      });
    }

    const transcribeData = await transcribeRes.json();
    if (!transcribeRes.ok || !transcribeData?.text) {
      console.error('Transcribe error:', JSON.stringify(transcribeData).slice(0, 300));
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Gagal mentranskripsi voice.');
      return null;
    }

    return String(transcribeData.text).trim();
  } catch (err) {
    console.error('transcribeVoiceNote error:', err.message);
    try {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Terjadi error saat proses voice.');
    } catch {}
    return null;
  }
}

/**
 * Konversi ArrayBuffer → base64 (untuk payload audio worker).
 */
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Kirim indikator "typing" ke Telegram (best-effort).
 */
async function sendChatAction(botToken, chat_id) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat_id, action: 'typing' }),
    });
  } catch {}
}

/**
 * Hapus pesan Telegram (best-effort, untuk hapus pesan berisi token).
 */
async function deleteTelegramMessage(botToken, chat_id, message_id) {
  if (!message_id) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat_id, message_id: message_id }),
    });
  } catch {}
}

/**
 * Konversi Markdown dasar ke HTML untuk Telegram parse_mode.
 * Urutan: escape HTML → lindungi code → tabel → header → inline code → bold → strikethrough → italic → links.
 *
 * - Header "## teks" / "# teks" → <b>teks</b> (Telegram tidak punya tag heading; tebal sebagai pengganti)
 * - Tabel pipe Markdown → rata-tengah monospace dalam <pre><code> agar kolom sejajar di Telegram
 */
function markdownToHtml(text) {
  if (!text) return '';
  let s = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const protectedBlocks = [];

  // 1. Lindungi fenced code blocks (```...```) dari processing lain
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000BLOCK${protectedBlocks.length - 1}\u0000`;
  });
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\u0000BLOCK${protectedBlocks.length - 1}\u0000`;
  });

  // 2. Lindungi inline code (`...`)
  s = s.replace(/`([^`]+)`/g, (m, code) => {
    protectedBlocks.push(`<code>${code}</code>`);
    return `\u0000BLOCK${protectedBlocks.length - 1}\u0000`;
  });

  // 3. Tabel pipe Markdown → monospace rata kolom
  s = convertMarkdownTables(s);

  // 4. Header "# teks" / "## teks" / "### teks" → bold
  s = s.replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^#{1,4}([^#\s].*)$/gm, '<b>$1</b>');

  // 5. Bold (**...**)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 6. Strikethrough (~~...~~)
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 7. Italic (*...*) — setelah bold agar tidak konflik
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');

  // 8. Links [teks](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 9. Pulihkan blok yang dilindungi
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => protectedBlocks[Number(i)] || m);

  return s;
}

/**
 * Deteksi blok tabel pipe Markdown dan ubah jadi monospace rata kolom.
 * Contoh input:
 *   | A | B |
 *   |---|---|
 *   | 1 | 2 |
 * Output: <pre><code>A | B\n1 | 2</code></pre> (kolom disejajarkan)
 */
function convertMarkdownTables(s) {
  const lines = s.split('\n');
  const out = [];
  let i = 0;

  const isSepRow = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line.trim()) || line.trim().startsWith('|');

  while (i < lines.length) {
    const line = lines[i];
    // Mulai tabel: baris pipe + baris berikutnya separator
    if (isTableRow(line) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const rows = [splitPipeRow(line)];
      i++; // separator
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
  return out.join('\n');
}

function splitPipeRow(line) {
  let l = line.trim();
  l = l.replace(/^\|/, '').replace(/\|$/, '');
  return l.split('|').map((c) => c.trim());
}

function formatTableMonospace(rows) {
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    widths.push(Math.max(...rows.map((r) => (r[c] || '').length)));
  }
  // Baris header pertama sebagai judul (tebal)
  const header = rows[0];
  const body = rows.slice(1);
  const fmt = (cells) =>
    cells.map((cell, c) => String(cell || '').padEnd(widths[c], ' ')).join(' | ').replace(/\s+$/, '');

  const lines = [];
  lines.push(fmt(header.map((c, idx) => `**${c}**`))); // header bold (ditangani pass bold)
  for (const r of body) lines.push(fmt(r));
  return `<pre><code>${lines.join('\n')}</code></pre>`;
}

/**
 * Send text via Telegram Bot API using native fetch().
 * Menggunakan parse_mode HTML agar bold/italic/code/strikethrough ter-render.
 */
async function sendTelegram(botToken, chat_id, text) {
  const html = markdownToHtml(text);
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat_id,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}
