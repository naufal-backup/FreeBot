// src/commands/projects.js
// /newproject, /projects, /storage, /cleanup, /purge, /need-supabase

import { sendTelegram } from "../telegram.js";
import { fmtBytes } from "../utils/format.js";
import { getServiceToken, getStorageUsage } from "../storage.js";
import { validateGithubToken, createGithubRepo, pushFilesToGithub } from "../github.js";
import { renderTemplate } from "../templates.js";

export async function handleProjectCommands(cmdWord, cmdArg, env, chatId, fromId, messageId) {
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
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi. Hubungi admin.");
      return true;
    }
    const pat = await getServiceToken(env, fromId, "github");
    if (!pat) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "GitHub belum tersambung. Kirim /login-gh dulu.");
      return true;
    }
    const githubLogin = await validateGithubToken(pat);
    if (!githubLogin) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Token GitHub tidak valid. Kirim /token-gh baru lalu ulangi.");
      return true;
    }
    const files = renderTemplate(template, projName);
    if (!files) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Template tidak dikenal: gunakan worker-hello, worker-api, atau ai-chat.");
      return true;
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
      return true;
    }
    const dup = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
    if (dup) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" sudah ada (termasuk punya user lain). Pilih nama lain.`);
      return true;
    }
    try {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Membuat project "${projName}" (${template})...`);
      const repo = await createGithubRepo(pat, projName);
      const fullName = repo.full_name;
      const pushed = await pushFilesToGithub(pat, fullName, files);
      if (!pushed) {
        await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Repo ${fullName} dibuat tapi push file gagal. Coba /purge lalu ulangi.`);
        return true;
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(projName, String(fromId), fullName, totalBytes, now, now).run();
      const projRow = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
      await env.DB.batch(
        files.map((f) =>
          env.DB.prepare("INSERT INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(
            projRow.id,
            f.path,
            f.content,
            f.size
          )
        )
      );
      await sendTelegram(
        env.TELEGRAM_TOKEN,
        chatId,
        `Project jadi: ${fullName}\nFile: ${files.length} (${fmtBytes(totalBytes)})\nRepo: https://github.com/${fullName}\nSimpanan: ${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}`
      );
    } catch (err) {
      console.error(err);
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Gagal buat project: ${err.message}`);
    }
    return true;
  }

  if (cmdWord === "/projects") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const rows = await env.DB.prepare(
      "SELECT name, github_repo, total_bytes, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC LIMIT 25"
    ).bind(String(fromId)).all();
    const list = (rows.results || [])
      .map((p) => `- ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 ${new Date(p.created_at).toISOString().slice(0, 10)} (${p.github_repo})`)
      .join("\n");
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      list ? `Projects (${rows.results.length}):\n${list}` : "Belum ada project. Ketik /newproject <nama> [template]."
    );
    return true;
  }

  if (cmdWord === "/storage") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const quota = Number(env.STORAGE_QUOTA_BYTES || 400 * 1024 * 1024);
    const usage = await getStorageUsage(env);
    const rows = await env.DB.prepare(
      "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC LIMIT 10"
    ).all();
    const filo = (rows.results || [])
      .map((p, i) => `#${i + 1} ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`)
      .join("\n");
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      "Storage D1: " +
        fmtBytes(usage) +
        " / " +
        fmtBytes(quota) +
        " (" +
        ((usage / quota) * 100).toFixed(1) +
        "%)\n\nUrutan hapus FILO (terbaru dulu):\n" +
        (filo || "(kosong)") +
        "\n\n/cleanup untuk rekomendasi, /purge <nama> [yes] untuk hapus."
    );
    return true;
  }

  if (cmdWord === "/cleanup") {
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const rows = await env.DB.prepare(
      "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10"
    ).all();
    const rec = (rows.results || [])
      .map(
        (p, i) =>
          `#${i + 1} ${p.name} \xB7 ${fmtBytes(p.total_bytes)} \xB7 akses terakhir ${new Date(p.last_accessed_at || p.created_at).toISOString().slice(0, 10)}`
      )
      .join("\n");
    await sendTelegram(
      env.TELEGRAM_TOKEN,
      chatId,
      (rec ? `Rekomendasi hapus (FILO terbaru dulu):\n${rec}\n\nKonfirmasi: /purge <nama> yes` : "Tidak ada project untuk dibersihkan.") +
        "\nCatatan: hapus hanya dari D1, repo GitHub tetap aman."
    );
    return true;
  }

  if (cmdWord === "/purge") {
    const args = cmdArg.split(/\s+/).filter(Boolean);
    const projName = args[0] || "";
    const yes = args[1] === "yes";
    if (!yes) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Yakin hapus "${projName}" dari D1? Balas: /purge ${projName} yes\n(Repo GitHub tidak dihapus.)`);
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const row = await env.DB.prepare("SELECT id FROM projects WHERE name = ? AND owner_id = ?").bind(projName, String(fromId)).first();
    if (!row) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" tidak ditemukan milikmu.`);
      return true;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM project_files WHERE project_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id)
    ]);
    await sendTelegram(env.TELEGRAM_TOKEN, chatId, `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`);
    return true;
  }

  if (cmdWord === "/need-supabase") {
    const projName = (cmdArg.split(/\s+/)[0] || "").toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,23}$/.test(projName)) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Format: /need-supabase <nama>\nnama: huruf kecil, angka, strip; 3-24 karakter.");
      return true;
    }
    if (!env.DB) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "D1 belum dikonfigurasi.");
      return true;
    }
    const pat = await getServiceToken(env, fromId, "supabase");
    if (!pat) {
      await sendTelegram(env.TELEGRAM_TOKEN, chatId, "Supabase belum tersambung. Kirim /login-sb dulu.");
      return true;
    }
    try {
      const orgs = await fetch("https://api.supabase.com/v1/organizations", { headers: { Authorization: `Bearer ${pat}` } });
      if (!orgs.ok) throw new Error("Organisasi Supabase tidak valid.");
      const orgList = await orgs.json();
      const orgId = (Array.isArray(orgList) ? orgList[0]?.id : null) || "";
      if (!orgId) throw new Error("Akun Supabase belum punya organisasi.");
      const createRes = await fetch("https://api.supabase.com/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pat}` },
        body: JSON.stringify({ name: projName, organization_id: orgId, plan: "free", region: "ap-southeast-1" })
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
    return true;
  }

  return false;
}
