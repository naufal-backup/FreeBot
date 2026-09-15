var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
function parseNaturalTime(text) {
  const norm = (text || "").toLowerCase().trim();
  const now = Date.now();
  const wibOff = 7 * 36e5;
  const wibNow = new Date(now + wibOff);
  let target = new Date(wibNow);
  const rel = norm.match(/(?:(?:dalam|in|after)\s+)?(\d+)\s*(menit|min(?:ute)?s?|mins?|m|jam|hours?|hour|h|hari|days?|day|d)\s*(lagi|)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const u = rel[2];
    const ms = u.startsWith("menit") || u.startsWith("min") || u === "m" ? 6e4 : u.startsWith("jam") || u.startsWith("hour") || u === "h" ? 36e5 : 864e5;
    return now + n * ms;
  }
  if (/besok|tomorrow/.test(norm)) target.setUTCDate(target.getUTCDate() + 1);
  if (/lusa|day after/.test(norm)) target.setUTCDate(target.getUTCDate() + 2);
  const days = { minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, sabtu: 6 };
  const dm = norm.match(/(?:next |)(senin|selasa|rabu|kamis|jumat|sabtu|ahad|minggu)/);
  if (dm) {
    let diff = (days[dm[1]] - target.getUTCDay() + 7) % 7;
    if (diff === 0) diff = 7;
    target.setUTCDate(target.getUTCDate() + diff);
  }
  const hm = norm.match(/(\d{1,2})[:.](\d{2})/);
  if (hm) {
    target.setUTCHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
  } else {
    const hx = norm.match(/(?:jam |pukul |at |)(\d{1,2})\s*(pagi|siang|sore|malam|am|pm)?\b/);
    if (hx) {
      let h = parseInt(hx[1], 10);
      const sfx = hx[2] || "";
      if ((sfx === "siang" || sfx === "sore" || sfx === "malam" || sfx === "pm") && h < 12) h += 12;
      if ((sfx === "pagi" || sfx === "am") && h === 12) h = 0;
      target.setUTCHours(h, 0, 0, 0);
    } else return null;
  }
  if (target.getTime() <= wibNow.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - wibOff;
}
__name(parseNaturalTime, "parseNaturalTime");
async function runScheduledTasks(env, ctx) {
  if (!env.DB) {
    console.error("runScheduledTasks: no DB");
    return;
  }
  const now = Date.now();
  const wib = new Date(now + 7 * 36e5);
  const hhmm = String(wib.getUTCHours()).padStart(2, "0") + ":" + String(wib.getUTCMinutes()).padStart(2, "0");
  const today = wib.toISOString().slice(0, 10);
  console.log("scheduled tick: " + hhmm + " WIB");
  try {
    const tasks = await env.DB.prepare("SELECT id,chat_id,task_text FROM tasks WHERE active=1 AND cron_time=?").bind(hhmm).all();
    console.log("cron tasks found: " + (tasks.results || []).length);
    for (const t of tasks.results || []) {
      const r = await env.DB.prepare("SELECT last_run FROM tasks WHERE id=?").bind(t.id).first();
      if (r?.last_run && r.last_run.slice(0, 10) === today) {
        console.log("cron " + t.id + " already ran today");
        continue;
      }
      try {
        const { base_url, api_key } = await getActiveApi(env, null);
        const m2 = env.AI_MODEL || "deepseek-v4-flash";
        const ai = await fetch(base_url + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + api_key },
          body: JSON.stringify({ model: m2, messages: [{ role: "system", content: "Jawab singkat." }, { role: "user", content: t.task_text }], max_tokens: 500 })
        });
        const d = await ai.json();
        const reply = (d?.choices?.[0]?.message?.content || "").trim().slice(0, 1e3);
        await sendTelegram(env.TELEGRAM_TOKEN, t.chat_id, "\u23F0 **Cron " + t.cron_time + "**: " + reply);
        await env.DB.prepare("UPDATE tasks SET last_run=? WHERE id=?").bind((/* @__PURE__ */ new Date()).toISOString(), t.id).run();
        console.log("cron " + t.id + " executed");
      } catch (e) {
        console.error("cron task error:", e.message);
      }
    }
  } catch (e) {
    console.error("cron query error:", e.message);
  }
  try {
    const rems = await env.DB.prepare("SELECT id,chat_id,message FROM pending_reminders WHERE done=0 AND remind_at<=?").bind(now).all();
    console.log("pending reminders due: " + (rems.results || []).length);
    for (const r of rems.results || []) {
      await sendTelegram(env.TELEGRAM_TOKEN, r.chat_id, "\u{1F514} **Pengingat:** " + r.message);
      await env.DB.prepare("UPDATE pending_reminders SET done=1 WHERE id=?").bind(r.id).run();
      console.log("reminder " + r.id + " sent");
    }
  } catch (e) {
    console.error("reminder error:", e.message);
  }
  try {
    await env.DB.prepare("DELETE FROM processed_updates WHERE created_at < ?").bind(Date.now() - 7 * 864e5).run();
  } catch (e) {
    console.error("cleanup processed_updates:", e.message);
  }
}
__name(runScheduledTasks, "runScheduledTasks");
var index_default = {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env, ctx));
  },
  async fetch(request, env, ctx) {
    // Top-level safety net: whatever happens below, Telegram MUST get a
    // response, or it will retry the same update repeatedly (this is what
    // caused the "Typing..." pile-up bug).
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("Unhandled top-level error:", err && err.stack || err);
      return new Response("OK", { status: 200 });
    }
  }
};
async function handleRequest(request, env, ctx) {
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
    const chatId = update?.message?.chat?.id;
    const voiceInfo = update?.message?.voice;
    let userText = update?.message?.text;
    const fromId = update?.message?.from?.id;
    const messageId = update?.message?.message_id;
    if (!chatId || !fromId) {
      return new Response("OK", { status: 200 });
    }
    if (!userText && voiceInfo) {
      const transcribed = await transcribeVoiceNote(env, voiceInfo, chatId);
      if (transcribed === null) {
        return new Response("OK", { status: 200 });
      }
      userText = transcribed;
      if (!userText) {
        return new Response("OK", { status: 200 });
      }
    } else if (!userText) {
      return new Response("OK", { status: 200 });
    }
    const cmdWord = userText.split(/\s+/)[0].replace(/_/g, "-");
    const cmdArg = userText.includes(" ") ? userText.slice(userText.indexOf(" ") + 1).trim() : "";
    if (cmdWord === "/stop") {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId })
      }).catch(() => {
      });
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "\u{1F6D1} Semua proses dihentikan.");
      return new Response("OK", { status: 200 });
    }
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
        "Perintah:\n/start - mulai\n/help - bantuan ini\n/model - lihat/ganti model sesi\n/models - daftar model\n/reset - hapus memori chat sesi\n/myid - lihat Telegram ID kamu\n/newproject <nama> [template] - buat project (worker-hello|worker-api|ai-chat) + repo GitHub\n/projects - list project\n/storage - status D1\n/cleanup - rekomendasi hapus (FILO)\n/purge <nama> yes - hapus dari D1\n/need-supabase <nama> - buat project Supabase\n/login-gh /token-gh <pat> /gh-status /logout-gh - kelola GitHub\n/login-sb /token-sb <pat> /sb-status /logout-sb - kelola Supabase\n/changeapi <url> <key> - ganti API sekaligus (provider + key)\n/changeprovider <url> - ganti provider, key tetap\n/changekey <key> - ganti key, provider tetap\n/api-status - lihat API aktif\n/resetapi - kembali ke default\n\nKetik teks bebas untuk chat AI."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/model") {
      const activeModel = await getActiveModel(env, chatId);
      const target = cmdArg.split(/\s+/)[0];
      if (!target) {
        const list = await formatModelList(env);
        const modelList = list ? `

Model tersedia (live /v1/models):
${list}` : "\n\n(daftar model gagal dimuat)";
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Model aktif sesi ini: ${activeModel}
Ganti: /model <nama>.${modelList}`);
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const models = await fetchModelList(env);
      const exists = models ? models.some((m2) => m2.id === target) : FALLBACK_MODELS.includes(target);
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
        list ? `Model aktif: ${activeModel}

Daftar model (live /v1/models):
${list}` : "Gagal memuat daftar model dari Geraikita. Coba lagi nanti."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/reset") {
      if (env.DB) {
        await env.DB.prepare("DELETE FROM chat_memory WHERE chat_id = ?").bind(String(chatId)).run();
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "\u2705 Memori chat dihapus.");
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
        names === null ? "Token Supabase tersimpan tapi tidak valid lagi. Kirim /token-sb baru atau /logout-sb." : names.length === 0 ? "Supabase tersambung. Belum ada project." : `Supabase tersambung. Projects (${names.length}):
${names.slice(0, 10).join("\n")}`
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
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API diganti ke: ${baseUrl}
(Simpan, pesan key dihapus.)`);
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
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Provider diganti ke: ${baseUrl}
Key tetap: ${maskApiKey(apiKey)}`);
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
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API aktif: ${config.base_url}
Key: ${maskApiKey(config.api_key)}

/resetapi untuk kembali ke default.`);
      } else {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `API default: ${DEFAULT_API_BASE}
Gunakan /changeapi untuk ganti.`);
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
    if (cmdWord === "/newproject") {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const projName = (args[0] || "").toLowerCase();
      const template = (args[1] || "worker-hello").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(projName)) {
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          "Format: /newproject <nama> [template]\nnama: huruf kecil, angka, strip; 3-50 karakter.\nTemplate: worker-hello | worker-api | ai-chat"
        );
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
        return new Response("OK", { status: 200 });
      }
      const pat = await getServiceToken(env, fromId, "github");
      if (!pat) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "GitHub belum tersambung. Kirim /login-gh dulu.");
        return new Response("OK", { status: 200 });
      }
      const githubLogin = await validateGithubToken(pat);
      if (!githubLogin) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub tidak valid. Kirim /token-gh baru lalu ulangi.");
        return new Response("OK", { status: 200 });
      }
      const files = renderTemplate(template, projName);
      if (!files) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Template tidak dikenal: gunakan worker-hello, worker-api, atau ai-chat.");
        return new Response("OK", { status: 200 });
      }
      const totalBytes = files.reduce((s, f) => s + f.size, 0);
      const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
      const usage = await getStorageUsage(env);
      if (usage + totalBytes > quota * 0.95) {
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Storage D1 hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Kirim /cleanup untuk melihat rekomendasi hapus, atau /storage.`
        );
        return new Response("OK", { status: 200 });
      }
      const dup = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
      if (dup) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" sudah ada (termasuk punya user lain). Pilih nama lain.`);
        return new Response("OK", { status: 200 });
      }
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Membuat project "${projName}" (${template})...`);
        const repo = await createGithubRepo(pat, projName);
        const fullName = repo.full_name;
        const pushed = await pushFilesToGithub(pat, fullName, files);
        if (!pushed) {
          await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Repo ${fullName} dibuat tapi push file gagal. Coba /purge lalu ulangi.`);
          return new Response("OK", { status: 200 });
        }
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(projName, String(fromId), fullName, totalBytes, now, now).run();
        const projRow = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
        await env.DB.batch(
          files.map(
            (f) => env.DB.prepare("INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(projRow.id, f.path, f.content, f.size)
          )
        );
        await sendTelegram(
          env.TELEGRAM_TOKEN,
          chatId,
          `Project jadi: ${fullName}
File: ${files.length} (${fmtBytes(totalBytes)})
Repo: https://github.com/${fullName}
Simpanan: ${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}`
        );
      } catch (err) {
        console.error(err);
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat project: ${err.message}`);
      }
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/projects") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
        return new Response("OK", { status: 200 });
      }
      const rows = await env.DB.prepare(
        "SELECT name, github_repo, total_bytes, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25"
      ).bind(String(fromId)).all();
      const list = (rows.results || []).map((p) => `- ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 ${new Date(p.created_at).toISOString().slice(0, 10)} (${p.github_repo})`).join("\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? `Projects (${rows.results.length}):
${list}` : "Belum ada project. Ketik /newproject <nama> [template].");
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
        (rec ? `Rekomendasi hapus (FILO terbaru dulu):
${rec}

Konfirmasi: /purge <nama> yes` : "Tidak ada project untuk dibersihkan.") + "\nCatatan: hapus hanya dari D1, repo GitHub tetap aman."
      );
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/purge") {
      const args = cmdArg.split(/\s+/).filter(Boolean);
      const projName = args[0] || "";
      const yes = args[1] === "yes";
      if (!yes) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Yakin hapus "${projName}" dari D1? Balas: /purge ${projName} yes
(Repo GitHub tidak dihapus.)`);
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
    if (cmdWord === "/cron") {
      const m2 = cmdArg.match(/^(\d{1,2}[:.]\d{2})\s+(.+)$/);
      if (!m2) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /cron HH:MM tugas\nContoh: /cron 09:00 ringkasan berita AI");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const cronTime = m2[1].replace(".", ":");
      await env.DB.prepare("INSERT INTO tasks (owner_id,chat_id,type,cron_time,task_text,active,created_at) VALUES (?,?,?,?,?,1,?)").bind(String(fromId), String(chatId), "cron", cronTime, m2[2], Date.now()).run();
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Cron dijadwalkan tiap **" + cronTime + "** WIB: " + m2[2]);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/crons") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const rows = await env.DB.prepare("SELECT id,cron_time,task_text,last_run,active FROM tasks WHERE owner_id=? AND type=? ORDER BY cron_time").bind(String(fromId), "cron").all();
      const list = (rows.results || []).map(
        (t) => "#" + t.id + " **" + t.cron_time + "** " + (t.active ? "\u2705" : "\u26D4") + " " + t.task_text + (t.last_run ? "\n   Terakhir: " + t.last_run.slice(0, 16) : "")
      ).join("\n\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? "**Cron tugas:**\n\n" + list + "\n\nHapus: /delcron <id>" : "Belum ada cron. Buat: /cron HH:MM tugas");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/delcron") {
      const id = parseInt(cmdArg.split(/\s+/)[0], 10);
      if (!id || !env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /delcron <id>\nLihat ID via /crons");
        return new Response("OK", { status: 200 });
      }
      await env.DB.prepare("DELETE FROM tasks WHERE id=? AND owner_id=?").bind(id, String(fromId)).run();
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Cron #" + id + " dihapus.");
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/remind") {
      const m2 = cmdArg.match(/^(.+?)\s+(.+)$/);
      if (!m2) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /remind <waktu> <pesan>\nContoh: /remind in 45 minutes meeting");
        return new Response("OK", { status: 200 });
      }
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const remindAt = parseNaturalTime(m2[1]);
      if (!remindAt) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, 'Waktu tidak dikenali. Contoh: "in 45 minutes", "besok jam 8 pagi"');
        return new Response("OK", { status: 200 });
      }
      await env.DB.prepare("INSERT INTO pending_reminders (owner_id,chat_id,remind_at,message,created_at) VALUES (?,?,?,?,?)").bind(String(fromId), String(chatId), remindAt, m2[2], Date.now()).run();
      const wib = new Date(remindAt + 7 * 36e5);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Pengingat: " + wib.toISOString().replace("T", " ").slice(0, 16) + " WIB \u2014 " + m2[2]);
      return new Response("OK", { status: 200 });
    }
    if (cmdWord === "/reminds") {
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 tidak tersedia.");
        return new Response("OK", { status: 200 });
      }
      const rows = await env.DB.prepare("SELECT id,remind_at,message,done FROM pending_reminders WHERE owner_id=? ORDER BY remind_at").bind(String(fromId)).all();
      const now = Date.now();
      const list = (rows.results || []).map(
        (r) => (r.done ? "\u2705" : "\u23F3") + " #" + r.id + " " + new Date(r.remind_at + 7 * 36e5).toISOString().replace("T", " ").slice(0, 16) + " WIB" + (r.done ? " (selesai)" : r.remind_at < now ? " (terlewat)" : "") + "\n   " + r.message
      ).join("\n\n");
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, list ? "**Pengingat:**\n\n" + list : "Belum ada pengingat.");
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
          `Project Supabase "${projName}" sedang diprovisioning (ref: ${created?.ref || created?.id || "?"}).
Cek status: /sb-status (bisa butuh beberapa menit).`
        );
      } catch (err) {
        console.error(err);
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat Supabase project: ${err.message}`);
      }
      return new Response("OK", { status: 200 });
    }
    const activeModelForId = await getActiveModel(env, chatId);
    const identityAnswer = canonicalIdentityAnswer(userText, activeModelForId);
    if (identityAnswer) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, identityAnswer);
      return new Response("OK", { status: 200 });
    }
    // These are declared here (outside the inner try) so the catch block
    // below can always see them, even if something throws before they're
    // assigned inside the try.
    let typingMessageId2 = null;
    let typingTimer = null;
    try {
      const { base_url, api_key } = await getActiveApi(env);
      const EXTERNAL_API_URL = `${base_url}/chat/completions`;
      const AI_MODEL = activeModelForId;
      try {
        const typingRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: "Typing..." })
        });
        const typingData = await typingRes.json();
        typingMessageId2 = typingData?.result?.message_id || null;
        if (typingMessageId2) {
          typingTimer = setTimeout(async () => {
            try {
              await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId2 })
              });
            } catch {
            }
          }, 3e4);
        }
      } catch {
      }
      let history = await getChatMemory(env, chatId);
      if (history.length >= 80) {
        const recent = history.slice(-20);
        if (typingMessageId2) {
          try {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId2, text: "Merangkum.." })
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

Kamu WAJIB menggunakan tool function calling saat dibutuhkan. Jangan menjawab dengan teks biasa jika ada tool yang bisa menjawab. Tool tersedia:
- websearch(query): cari informasi terkini dari web. Panggil saat user bertanya berita / fakta / info.
- get_current_time(): cek waktu sekarang. Panggil saat user tanya jam / tanggal / hari.
- list_projects(): lihat daftar project user di D1.
- storage_status(): cek status storage D1.
- cleanup_recommendations(): rekomendasi hapus project (FILO).
- list_models(): daftar model AI yang tersedia.
- switch_model(model): ganti model AI sesi ini.
- newproject(name, template): buat project baru + repo GitHub. Konfirmasi dulu ke user.
- purge_project(name): hapus project dari D1 (repo GitHub tetap ada). Konfirmasi dulu ke user.
- commit_files(repo, message, files): commit file ke GitHub. Gunakan saat user kirim kode.
- list_repo_files(repo, path): lihat daftar file di repo GitHub. Panggil saat user minta "cek isi repo", "lihat file", "isi repo".
- read_repo_file(repo, path): baca isi file dari GitHub. Panggil saat user minta "baca file", "tampilkan isi file".
- delete_repo(repo): hapus repo GitHub permanen. Konfirmasi dulu ke user.
- list_github_repos(): lihat semua repo GitHub milikmu.
- change_repo_visibility(repo, private): ubah visibilitas repo (public/private). Konfirmasi dulu.
- create_repo_branch(repo, branch): buat branch baru dari main/sumber lain.
- delete_repo_file(repo, path): hapus file dari repo via commit. Konfirmasi dulu.

Untuk setiap pesan user, periksa apakah ada tool yang relevan. Jangan menjawab dengan teks biasa jika tool tersedia.`;
      const messages = [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userText }
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
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
      if (typingMessageId2) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId2 })
          });
        } catch {
        }
      }
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, String(finalContent).trim().slice(0, 4096));
      history = [...history, { role: "user", content: userText }, { role: "assistant", content: String(finalContent).trim() }];
      await saveChatMemory(env, chatId, history);
    } catch (err) {
      console.error(err);
      // FIX: this used to reference an undeclared `typingMessageId`
      // (should be `typingMessageId2`), which threw a ReferenceError
      // inside the catch block itself. That meant fetch() never returned
      // a Response, Telegram never got its 200 OK, and Telegram retried
      // the same webhook update repeatedly -- each retry spawning a new
      // undeleted "Typing..." bubble. This is what caused the pile-up.
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
      if (typingMessageId2) {
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/deleteMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, message_id: typingMessageId2 })
          });
        } catch {
        }
      }
      try {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Sorry, something went wrong. Try again.");
      } catch {
      }
    }
    return new Response("OK", { status: 200 });
}
__name(handleRequest, "handleRequest");
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
      name: "get_current_time",
      description: "Dapatkan waktu dan tanggal sekarang (UTC dan WIB).",
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
      description: 'Buat project baru + repo GitHub. HANYA eksekusi jika user mengonfirmasi dengan jelas dalam pesannya (misal: "iya, buatkan" atau "ya, buat project toko-api").',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama project (huruf kecil, angka, strip)" },
          template: {
            type: "string",
            enum: ["worker-hello", "worker-api", "ai-chat"],
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
  },
  {
    type: "function",
    function: {
      name: "commit_files",
      description: "Commit file ke repo GitHub yang sudah ada. HANYA eksekusi jika user mengonfirmasi dengan jelas atau mengirim kode yang mau di-commit.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          message: { type: "string", description: "Pesan commit" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Path file" },
                content: { type: "string", description: "Isi file" }
              },
              required: ["path", "content"]
            }
          }
        },
        required: ["repo", "message", "files"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_repo_files",
      description: "Lihat daftar file di repo GitHub. Hasilnya daftar path file.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          path: { type: "string", description: "Path subfolder (kosong utk root)" }
        },
        required: ["repo"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_repo_file",
      description: "Baca isi file dari repo GitHub.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          path: { type: "string", description: "Path file (src/index.js)" }
        },
        required: ["repo", "path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_repo",
      description: 'Hapus repo GitHub secara permanen. HANYA eksekusi jika user mengonfirmasi dengan jelas (misal: "iya, hapus repo X").',
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" }
        },
        required: ["repo"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "change_repo_visibility",
      description: "Ubah visibilitas repo GitHub (public/private). HANYA eksekusi jika user mengonfirmasi dengan jelas.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          private: { type: "boolean", description: "true=private, false=public" }
        },
        required: ["repo", "private"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_github_repos",
      description: "Lihat semua repo GitHub milik user.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "create_repo_branch",
      description: "Buat branch baru di repo GitHub.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          branch: { type: "string", description: "Nama branch baru" },
          from_branch: { type: "string", description: "Branch sumber (default: main)" }
        },
        required: ["repo", "branch"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_repo_file",
      description: "Hapus file dari repo GitHub (dengan commit). HANYA eksekusi jika user mengonfirmasi.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Full name repo (owner/repo)" },
          path: { type: "string", description: "Path file yang akan dihapus" },
          message: { type: "string", description: "Pesan commit" }
        },
        required: ["repo", "path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "generate_file",
      description: 'Buat file teks (md/txt/js/py/html/css/json/csv/yaml/svg/xml/sh/ts) dan kirim ke user. Panggil saat user minta "buat file", "generate", "kirim file".',
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Nama file dengan extension (contoh: app.js, README.md)" },
          content: { type: "string", description: "Isi file" }
        },
        required: ["name", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cron_list",
      description: "Tampilkan semua tugas cron yang sudah dijadwalkan untuk user ini.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "cron_create",
      description: 'Buat tugas cron harian baru. Panggil saat user minta "jadwalkan cron", "buat cron", "tugas harian".',
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "Waktu dalam format HH:MM (24 jam WIB)" },
          task: { type: "string", description: "Pesan/tugas yang akan dijalankan AI setiap hari" }
        },
        required: ["time", "task"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "cron_delete",
      description: 'Hapus tugas cron berdasarkan ID. Panggil saat user minta "hapus cron", "batalkan cron". TANYAKAN ID dulu ke user.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "ID cron dari daftar /crons" }
        },
        required: ["id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reminder_set",
      description: 'Buat pengingat satu kali. Panggil saat user minta "ingatkan", "remind", "pengingat".',
      parameters: {
        type: "object",
        properties: {
          waktu: { type: "string", description: 'Waktu natural: "in 45 minutes", "besok jam 8 pagi", "next tuesday at 3 pm"' },
          pesan: { type: "string", description: "Pesan pengingat" }
        },
        required: ["waktu", "pesan"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "webfetch",
      description: 'Ambil isi URL website dan kembalikan sebagai teks. Panggil saat user minta "buka link", "cek website", "ambil halaman".',
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL lengkap yang ingin dibuka" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "Baca isi dokumen PDF atau DOCX yang dikirim user. Gunakan saat user upload dokumen dan minta dibaca/dianalisis.",
      parameters: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "file_id dari dokumen Telegram" },
          file_name: { type: "string", description: "Nama file (contoh: laporan.pdf)" }
        },
        required: ["file_id", "file_name"]
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
        return `Waktu sekarang: ${day}, ${date} ${wibStr}
(UTC: ${utc})`;
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
        return models.map((m2) => `${m2.id} (${m2.vendor})`).join("\n");
      }
      case "switch_model": {
        const model = args.model;
        if (!model) return "Model tidak boleh kosong.";
        const modelList = await fetchModelList(env);
        const exists = modelList ? modelList.some((m2) => m2.id === model) : FALLBACK_MODELS.includes(model);
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
        const dup = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
        if (dup) return `Project "${projName}" sudah ada.`;
        const repo = await createGithubRepo(pat, projName);
        await pushFilesToGithub(pat, repo.full_name, files);
        const now = Date.now();
        await env.DB.prepare("INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)").bind(projName, String(fromId), repo.full_name, totalBytes, now, now).run();
        const projRow = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
        await env.DB.batch(files.map((f) => env.DB.prepare("INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(projRow.id, f.path, f.content, f.size)));
        return `Project "${projName}" dibuat: https://github.com/${repo.full_name}
File: ${files.length} (${fmtBytes(totalBytes)})`;
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
      case "commit_files": {
        const repo = args.repo;
        const message = args.message || "Update via telegram-ai-bot";
        const files = args.files;
        if (!repo || !Array.isArray(files) || files.length === 0) return "repo dan files (array) harus diisi.";
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        await commitToRepo(pat, repo, message, files, "main");
        const proj = await env.DB.prepare("SELECT id FROM projects WHERE owner_id = ? AND github_repo = ?").bind(String(fromId), repo).first();
        if (proj) {
          for (const f of files) {
            const sz = new TextEncoder().encode(f.content || "").length;
            await env.DB.prepare("INSERT OR REPLACE INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(proj.id, f.path, f.content || "", sz).run();
          }
          const total = await getStorageUsage(env);
          await env.DB.prepare("UPDATE projects SET total_bytes = (SELECT COALESCE(SUM(size),0) FROM project_files WHERE project_id=?), last_accessed_at = ? WHERE id = ?").bind(proj.id, Date.now(), proj.id).run();
        }
        return `Commit berhasil ke ${repo} (${files.length} file). Pesan: "${message}"`;
      }
      case "list_repo_files": {
        const repo = args.repo;
        const folderPath = args.path || "";
        if (!repo) return "repo harus diisi.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        const files = await listRepoContents(pat, repo, folderPath);
        if (files === null) return `Gagal membaca repo ${repo}.`;
        if (files.length === 0) return `Repo ${repo} kosong di path "${folderPath}".`;
        return files.map((f) => `${f.type === "dir" ? "[folder]" : "[file]"} ${f.path} (${f.size > 0 ? Math.round(f.size / 1024) + "KB" : "0KB"})`).join("\n");
      }
      case "read_repo_file": {
        const repo = args.repo;
        const filePath = args.path;
        if (!repo || !filePath) return "repo dan path harus diisi.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        const content = await readRepoFile(pat, repo, filePath);
        if (content === null) return `Gagal membaca file ${filePath} dari ${repo}.`;
        return content;
      }
      case "delete_repo": {
        const repo = args.repo;
        if (!repo || !repo.includes("/")) return "repo harus format owner/repo (contoh: naufal-backup/naufal).";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        try {
          const res = await fetch(`https://api.github.com/repos/${repo}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
          });
          if (!res.ok && res.status !== 204) {
            const errData = await res.json().catch(() => ({}));
            return `Gagal hapus repo ${repo}: ${errData?.message || res.status}`;
          }
          const proj = await env.DB.prepare("SELECT id FROM projects WHERE owner_id = ? AND github_repo = ?").bind(String(fromId), repo).first();
          if (proj) {
            await env.DB.batch([
              env.DB.prepare("DELETE FROM project_files WHERE project_id = ?").bind(proj.id),
              env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(proj.id)
            ]);
          }
          return `Repo ${repo} berhasil dihapus dari GitHub.`;
        } catch (err) {
          return `Error hapus repo: ${err.message}`;
        }
      }
      case "change_repo_visibility": {
        const repo = args.repo;
        const isPrivate = args.private !== false;
        if (!repo) return "repo harus diisi.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        try {
          const res = await fetch(`https://api.github.com/repos/${repo}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot", "Content-Type": "application/json" },
            body: JSON.stringify({ private: isPrivate })
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            return `Gagal ubah visibilitas: ${errData?.message || res.status}`;
          }
          return `Repo ${repo} sekarang ${isPrivate ? "private" : "public"}.`;
        } catch (err) {
          return `Error ubah visibilitas: ${err.message}`;
        }
      }
      case "list_github_repos": {
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung.";
        try {
          const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
          });
          if (!res.ok) return `HTTP ${res.status}`;
          const repos = await res.json();
          return repos.map((r) => `${r.private ? "\u{1F512}" : "\u{1F310}"} ${r.full_name}`).join("\n");
        } catch (err) {
          return `Error: ${err.message}`;
        }
      }
      case "create_repo_branch": {
        const repo = args.repo;
        const newBranch = args.branch;
        const fromBranch = args.from_branch || "main";
        if (!repo || !newBranch) return "repo dan branch harus diisi.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung.";
        try {
          const refRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${fromBranch}`, {
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
          });
          if (!refRes.ok) return `Branch "${fromBranch}" tidak ditemukan.`;
          const refData = await refRes.json();
          const sha = refData?.object?.sha;
          if (!sha) return "Tidak dapat membaca SHA branch sumber.";
          const createRes = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
            method: "POST",
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot", "Content-Type": "application/json" },
            body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha })
          });
          if (!createRes.ok) {
            const errData = await createRes.json().catch(() => ({}));
            return `Gagal buat branch: ${errData?.message || createRes.status}`;
          }
          return `Branch ${newBranch} berhasil dibuat di ${repo} (dari ${fromBranch}).`;
        } catch (err) {
          return `Error: ${err.message}`;
        }
      }
      case "delete_repo_file": {
        const repo = args.repo;
        const filePath = args.path;
        const msg = args.message || `Delete ${filePath} via telegram-ai-bot`;
        if (!repo || !filePath) return "repo dan path harus diisi.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung.";
        try {
          const fileRes = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
          });
          if (!fileRes.ok) return `File tidak ditemukan: HTTP ${fileRes.status}`;
          const fileData = await fileRes.json();
          const sha = fileData?.sha;
          if (!sha) return "Tidak dapat membaca SHA file.";
          const delRes = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot", "Content-Type": "application/json" },
            body: JSON.stringify({ message: msg, sha })
          });
          if (!delRes.ok) {
            const errData = await delRes.json().catch(() => ({}));
            return `Gagal hapus file: ${errData?.message || delRes.status}`;
          }
          return `File ${filePath} dihapus dari ${repo}.`;
        } catch (err) {
          return `Error: ${err.message}`;
        }
      }
      case "generate_file": {
        const fileName = args.name || "file.txt";
        const content = args.content || "";
        if (!content) return "Konten file tidak boleh kosong.";
        const allowedExts = [".md", ".txt", ".js", ".py", ".html", ".css", ".json", ".yaml", ".yml", ".toml", ".csv", ".sh", ".ts", ".svg", ".xml", ".env", ".ini"];
        const ext = "." + fileName.split(".").pop().toLowerCase();
        if (!allowedExts.includes(ext)) return `Format ${ext} tidak didukung. Yang didukung: ${allowedExts.join(", ")}`;
        const result = await sendTelegramDocument(env.TELEGRAM_TOKEN, chatId, fileName, content);
        if (!result.ok) return `\u274C Gagal mengirim file: ${result.error}`;
        return `\u2705 File **${fileName}** berhasil dikirim. Silakan cek chat untuk mendownload.`;
      }
      case "cron_list": {
        if (!env.DB) return "D1 tidak tersedia.";
        const rows = await env.DB.prepare("SELECT id,cron_time,task_text,last_run,active FROM tasks WHERE owner_id=? AND type=? ORDER BY cron_time").bind(String(fromId), "cron").all();
        const list = (rows.results || []).map(
          (t) => "#" + t.id + " " + t.cron_time + " " + (t.active ? "[Aktif]" : "[Nonaktif]") + " " + t.task_text + (t.last_run ? " (terakhir: " + t.last_run.slice(0, 10) + ")" : " (belum jalan)")
        ).join("\n");
        return list ? list : "Belum ada cron.";
      }
      case "cron_create": {
        const time = args.time;
        const task = args.task;
        if (!time || !/^\d{1,2}[:.]\d{2}$/.test(time)) return "Format waktu: HH:MM";
        if (!task || task.length < 3) return "Tugas terlalu pendek.";
        if (!env.DB) return "D1 tidak tersedia.";
        const cronTime = time.replace(".", ":");
        await env.DB.prepare("INSERT INTO tasks (owner_id,chat_id,type,cron_time,task_text,active,created_at) VALUES (?,?,?,?,?,1,?)").bind(String(fromId), String(chatId), "cron", cronTime, task, Date.now()).run();
        return "Cron dijadwalkan tiap " + cronTime + " WIB: " + task;
      }
      case "cron_delete": {
        const id = args.id;
        if (!id || !env.DB) return "ID cron diperlukan.";
        await env.DB.prepare("DELETE FROM tasks WHERE id=? AND owner_id=?").bind(id, String(fromId)).run();
        return "Cron #" + id + " dihapus.";
      }
      case "reminder_set": {
        const waktu = args.waktu;
        const pesan = args.pesan;
        if (!waktu || !pesan) return "Waktu dan pesan diperlukan.";
        if (!env.DB) return "D1 tidak tersedia.";
        const remindAt = parseNaturalTime(waktu);
        if (!remindAt) return 'Waktu tidak dikenali. Contoh: "in 45 min", "besok jam 8 pagi"';
        await env.DB.prepare("INSERT INTO pending_reminders (owner_id,chat_id,remind_at,message,created_at) VALUES (?,?,?,?,?)").bind(String(fromId), String(chatId), remindAt, pesan, Date.now()).run();
        const wib = new Date(remindAt + 7 * 36e5);
        return "Pengingat: " + wib.toISOString().replace("T", " ").slice(0, 16) + " WIB \u2014 " + pesan;
      }
      case "webfetch": {
        const url = args.url || "";
        if (!/^https?:\/\//.test(url)) return "URL harus diawali http:// atau https://";
        try {
          const res = await fetch(url, { headers: { "User-Agent": "telegram-ai-bot/1.0" } });
          if (!res.ok) return "HTTP " + res.status;
          const ct = res.headers.get("content-type") || "";
          let body = await res.text();
          if (ct.includes("text/html")) {
            body = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
            body = body.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
          }
          return body.trim().slice(0, 8e3) || "(Halaman kosong.)";
        } catch (err) {
          return "Gagal: " + err.message;
        }
      }
      case "read_document": {
        const fileId = args.file_id;
        const fileName = args.file_name || "dokumen";
        if (!fileId) return "file_id diperlukan.";
        try {
          const text = await extractDocumentText(env, fileId, fileName);
          if (!text || !text.trim()) return "Tidak dapat mengekstrak teks dari dokumen.";
          return `**${fileName}:**

${text.trim().slice(0, 15e3)}`;
        } catch (err) {
          return `Gagal membaca dokumen: ${err.message}`;
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
    return data.data.filter((m2) => typeof m2?.id === "string" && m2.id.length > 0).map((m2) => ({ id: m2.id, vendor: m2.owned_by || "Lainnya" }));
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
  for (const m2 of models) {
    const label = VENDOR_LABEL[m2.vendor] || m2.vendor;
    (byVendor[label] ||= []).push(m2.id);
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
    const res = await fetch(`${base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api_key}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "Kamu adalah perangkum percakapan yang teliti. Dari isi percakapan berikut, hasilkan ringkasan yang MEMPERTAHANKAN KONTEKS penting dengan lengkap, dalam Bahasa Indonesia: (1) topik-topik yang dibahas, (2) fakta yang user sebut (nama, proyek, angka, preferensi), (3) keputusan/kesepakatan, (4) nada dan hubungan. Tulis sebagai poin-poin jelas, jangan buang detail pada 20 pesan terakhir (itu dikelola terpisah). Jangan menambahkan informasi yang tidak ada. Maksimal 6000 karakter." },
          ...history
        ],
        max_tokens: 2e3
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return null;
    const trimmed = text.trim().slice(0, SUMMARY_MAX_CHARS);
    if (!trimmed) return null;
    return [{ role: "system", content: `Ringkasan percakapan sebelumnya:
${trimmed}` }];
  } catch {
    return null;
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
    put("wrangler.toml", `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true
`);
    put("src/index.js", `/**
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
    put("package.json", `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "worker-api") {
    put("wrangler.toml", `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true
`);
    put("src/index.js", `/**
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
    put("package.json", `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "ai-chat") {
    put("wrangler.toml", `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "${repoName}"
database_id = "CHANGE_ME"
`);
    put("src/index.js", `/**
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
    put("package.json", `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`);
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
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
      description: "Generated by telegram-ai-bot",
      private: true,
      auto_init: true,
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
async function commitToRepo(pat, fullName, message, files, branch = "main") {
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "telegram-ai-bot"
  };
  const base = `https://api.github.com/repos/${fullName}`;
  const refRes = await fetch(`${base}/git/refs/heads/${branch}`, { headers });
  let parentSha = "";
  let treeBase = null;
  if (refRes.ok) {
    const refData = await refRes.json();
    parentSha = refData?.object?.sha || "";
    treeBase = refData?.object?.tree_sha || null;
  }
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
  const treeBody = treeBase ? { tree: blobs, base_tree: treeBase } : { tree: blobs };
  const treeRes = await fetch(`${base}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify(treeBody)
  });
  const tree = await treeRes.json();
  if (!treeRes.ok) throw new Error(tree?.message || "git tree error");
  const commitRes = await fetch(`${base}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : []
    })
  });
  const commit = await commitRes.json();
  if (!commitRes.ok) throw new Error(commit?.message || "git commit error");
  const updateRes = await fetch(`${base}/git/refs/heads/${branch}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: commit.sha, force: false })
  });
  if (!updateRes.ok) {
    const errData = await updateRes.json().catch(() => ({}));
    throw new Error(errData?.message || "git update ref error");
  }
}
__name(commitToRepo, "commitToRepo");
async function listRepoContents(pat, repo, folderPath) {
  if (!folderPath) folderPath = "";
  const url = folderPath ? `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(folderPath)}` : `https://api.github.com/repos/${repo}/contents`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.map((f) => ({
      path: f.path,
      type: f.type || "file",
      size: f.size || 0
    }));
  } catch {
    return null;
  }
}
__name(listRepoContents, "listRepoContents");
async function readRepoFile(pat, repo, filePath) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`, {
      headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json", "User-Agent": "telegram-ai-bot" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.content) return null;
    return atob(data.content.replace(/\s/g, ""));
  } catch {
    return null;
  }
}
__name(readRepoFile, "readRepoFile");
async function getServiceToken(env, fromId, service) {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT token FROM service_tokens WHERE owner_id = ? AND service = ?").bind(String(fromId), service).first();
  return row?.token || null;
}
__name(getServiceToken, "getServiceToken");
function extractPdfText(data) {
  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(data);
  let cleaned = raw.replace(/\/[A-Za-z]+\s*<<[\s\S]*?>>/g, "").replace(/\/Filter\s*\/[A-Za-z0-9]+/g, "");
  const results = [];
  let m2;
  const tjRe = /\(([^)]*)\)\s*Tj/g;
  while ((m2 = tjRe.exec(raw)) !== null) results.push(m2[1]);
  const tjArrRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m2 = tjArrRe.exec(raw)) !== null) {
    const inner = m2[1].match(/\(([^)]*)\)/g);
    if (inner) for (const i of inner) results.push(i.slice(1, -1));
  }
  const text = results.join(" ").trim();
  if (text) return text;
  const btRe = /BT\s*([\s\S]*?)\s*ET/g;
  const btResults = [];
  while ((m2 = btRe.exec(raw)) !== null) {
    const lines = m2[1].match(/\(([^)]*)\)/g);
    if (lines) for (const l of lines) btResults.push(l.slice(1, -1));
  }
  return btResults.join(" ").trim() || "(Teks tidak dapat diekstrak. PDF mungkin terkompresi atau scan.)";
}
__name(extractPdfText, "extractPdfText");
function extractDocxText(data) {
  try {
    const view = new DataView(data.buffer || data);
    let offset = 0;
    const files = {};
    while (offset + 30 < data.length) {
      if (view.getUint32(offset, true) !== 67324752) {
        offset++;
        continue;
      }
      const compressedSize = view.getUint32(offset + 18, true);
      const fileNameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameOff = offset + 30;
      const name = new TextDecoder().decode(data.slice(nameOff, nameOff + fileNameLen));
      const dataOff = nameOff + fileNameLen + extraLen;
      const compData = data.slice(dataOff, dataOff + compressedSize);
      files[name] = compData;
      offset = dataOff + compressedSize;
    }
    const docXml = files["word/document.xml"] || files["word/document2.xml"] || Object.values(files).find((v, k) => k.includes("document.xml"));
    if (!docXml) return "(Tidak ditemukan word/document.xml dalam DOCX.)";
    const xml = new TextDecoder("utf-8", { fatal: false }).decode(docXml);
    const texts = [];
    let pos = 0;
    const wtRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let m;
    while ((m = wtRe.exec(xml)) !== null) {
      texts.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    }
    return texts.join("\n").trim() || "(Teks kosong.)";
  } catch (err) {
    return `(Gagal baca DOCX: ${err.message})`;
  }
}
__name(extractDocxText, "extractDocxText");
async function extractDocumentText(env, fileId, fileName) {
  const fileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId })
  });
  const fileData = await fileRes.json();
  const filePath = fileData?.result?.file_path;
  if (!filePath) throw new Error("File tidak ditemukan di Telegram.");
  const dl = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  if (!dl.ok) throw new Error("Gagal download file.");
  const buf = await dl.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (/\.pdf$/i.test(fileName)) return extractPdfText(bytes);
  if (/\.docx$/i.test(fileName)) return extractDocxText(bytes);
  throw new Error("Format tidak didukung. Kirim PDF atau DOCX.");
}
__name(extractDocumentText, "extractDocumentText");
async function sendTelegramDocument(botToken, chatId, fileName, content) {
  try {
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    const blob = new Blob([content], { type: "text/plain; charset=utf-8" });
    formData.append("document", blob, fileName);
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.error("sendDocument failed:", JSON.stringify(errData));
      return { ok: false, error: errData?.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("sendDocument error:", err.message);
    return { ok: false, error: err.message };
  }
}
__name(sendTelegramDocument, "sendTelegramDocument");
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
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m2, lang, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/```([\s\S]*?)```/g, (m2, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/`([^`]+)`/g, (m2, code) => {
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
  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m2, i) => protectedBlocks[Number(i)] || m2);
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
