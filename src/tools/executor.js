// src/tools/executor.js
// Executes a single tool call requested by the AI model and returns a
// string result to feed back into the conversation.

import { fmtBytes } from "../utils/format.js";
import { parseNaturalTime } from "../utils/time.js";
import { markdownToHtml } from "../utils/markdown.js";
import { generatePdfHtml } from "../utils/pdfTemplate.js";
import { sendTelegramDocument } from "../telegram.js";
import { extractDocumentText } from "../documents.js";
import {
  validateGithubToken,
  createGithubRepo,
  pushFilesToGithub,
  commitToRepo,
  pullRepo,
  listRepoContents,
  readRepoFile
} from "../github.js";
import { getServiceToken, getStorageUsage } from "../storage.js";
import { saveCustomTool, getCustomTools, deleteCustomTool, executeCustomTool } from "../skills.js";
import { getAllModels, resolveModelLabel, setActiveModel } from "../models.js";
import { renderTemplate } from "../templates.js";

export async function toolWebsearch(query) {
  if (!query) return "Query tidak boleh kosong.";
  try {
    const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
    });
    if (!res.ok) return "Gagal mengakses Bing.";
    const html = await res.text();
    const results = [];
    // Extract search results from <li class="b_algo">
    const liRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = liRegex.exec(html)) && results.length < 5) {
      const block = match[1];
      // Extract title from <a> tag
      const titleMatch = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      // Extract URL from href
      const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/i);
      // Extract snippet - text after the <a> tag
      const snippetMatch = block.match(/<\/a>([\s\S]*?)$/i);
      if (titleMatch && urlMatch) {
        const title = titleMatch[1].replace(/<[^>]*>/g, "").trim();
        const url = urlMatch[1].replace(/&amp;/g, "&");
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().slice(0, 200) : "";
        if (title && url) {
          results.push({ title, url, snippet });
        }
      }
    }
    if (results.length === 0) return `Tidak ada hasil untuk "${query}". Coba kata kunci lain.`;
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  } catch {
    return "Error saat mencari di web.";
  }
}

export async function executeTool(toolCall, env, chatId, fromId) {
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
        const now = new Date();
        const utc = now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
        const wib = new Date(now.getTime() + 7 * 3600000);
        const wibStr = wib.toISOString().replace("T", " ").slice(0, 19) + " WIB";
        const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
        const day = days[wib.getUTCDay()];
        const date = wib.toISOString().slice(0, 10);
        return `Waktu sekarang: ${day}, ${date} ${wibStr}\n(UTC: ${utc})`;
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
        return `Storage: ${fmtBytes(usage)} / ${fmtBytes(quota)} (${((usage / quota) * 100).toFixed(1)}%)`;
      }

      case "cleanup_recommendations": {
        if (!env.DB) return "D1 tidak tersedia.";
        const rows = await env.DB.prepare(
          "SELECT name, total_bytes, created_at, last_accessed_at FROM projects ORDER BY created_at DESC, total_bytes DESC, last_accessed_at ASC LIMIT 10"
        ).all();
        const rec = (rows.results || [])
          .map((p, i) => `#${i + 1} ${p.name} \u2014 ${fmtBytes(p.total_bytes)} \u2014 dibuat ${new Date(p.created_at).toISOString().slice(0, 10)}`)
          .join("\n");
        return rec || "Tidak ada project untuk dibersihkan.";
      }

      case "list_models": {
        const models = await getAllModels(env);
        if (!models.length) return "Tidak ada provider yang berhasil memuat model.";
        return models.map((m) => m.dispLabel).join("\n");
      }

      case "switch_model": {
        const model = args.model;
        if (!model) return "Model tidak boleh kosong.";
        const resolved = await resolveModelLabel(env, model);
        if (!resolved) return `Model "${model}" tidak dikenal. Gunakan /models untuk melihat daftar (format model:provider).`;
        await setActiveModel(env, chatId, resolved);
        return `Model sesi ini diganti ke: ${resolved}`;
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
        if (usage + totalBytes > quota * 0.95)
          return `Storage hampir penuh (${fmtBytes(usage + totalBytes)} / ${fmtBytes(quota)}). Hapus dulu project lain.`;
        const dup = await env.DB.prepare("SELECT id FROM projects WHERE name = ?").bind(projName).first();
        if (dup) return `Project "${projName}" sudah ada.`;
        const repo = await createGithubRepo(pat, projName);
        await pushFilesToGithub(pat, repo.full_name, files);
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO projects (name, owner_id, github_repo, total_bytes, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(projName, String(fromId), repo.full_name, totalBytes, now, now).run();
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
        return `Project "${projName}" dibuat: https://github.com/${repo.full_name}\nFile: ${files.length} (${fmtBytes(totalBytes)})`;
      }

      case "purge_project": {
        const projName = (args.name || "").toLowerCase();
        if (!projName) return "Nama project tidak boleh kosong.";
        if (!env.DB) return "D1 tidak tersedia.";
        console.log(`[SECURITY] purge_project called: name=${projName} by user=${fromId}`);
        const row = await env.DB.prepare("SELECT id FROM projects WHERE name = ? AND owner_id = ?").bind(projName, String(fromId)).first();
        if (!row) return `Project "${projName}" tidak ditemukan.`;
        await env.DB.batch([
          env.DB.prepare("DELETE FROM project_files WHERE project_id = ?").bind(row.id),
          env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id)
        ]);
        return `Project "${projName}" dihapus dari D1. Repo GitHub tetap ada.`;
      }

      case "commit_files": {
        const repo = args.repo;
        const message = args.message || "Update via telegram-ai-bot";
        const files = args.files;
        if (!repo || !Array.isArray(files) || files.length === 0) return "repo dan files (array) harus diisi.";
        console.log(`[SECURITY] commit_files called: repo=${repo} files=${files.length} by user=${fromId}`);
        if (!env.DB) return "D1 tidak tersedia.";
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";

        let remoteState;
        try {
          remoteState = await pullRepo(pat, repo, "main");
        } catch (e) {
          return `Pull gagal: ${e.message}. Commit dibatalkan.`;
        }

        await commitToRepo(pat, repo, message, files, "main");

        const proj = await env.DB.prepare("SELECT id FROM projects WHERE owner_id = ? AND github_repo = ?").bind(String(fromId), repo).first();
        let storageInfo = "";
        if (proj) {
          for (const f of files) {
            const sz = new TextEncoder().encode(f.content || "").length;
            await env.DB.prepare("INSERT OR REPLACE INTO project_files (project_id, path, content, size) VALUES (?, ?, ?, ?)").bind(
              proj.id,
              f.path,
              f.content || "",
              sz
            ).run();
          }
          await env.DB.prepare(
            "UPDATE projects SET total_bytes = (SELECT COALESCE(SUM(size),0) FROM project_files WHERE project_id=?), last_accessed_at = ? WHERE id = ?"
          ).bind(proj.id, Date.now(), proj.id).run();
          const usage = await getStorageUsage(env, String(fromId));
          storageInfo = `\n\nStorage: ${fmtBytes(usage.used)} / ${fmtBytes(usage.limit)}. Ingin bersihkan storage? Gunakan /cleanup.`;
        }
        return `Commit berhasil ke ${repo} (${files.length} file). Pesan: "${message}"${storageInfo}`;
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
        console.log(`[SECURITY] delete_repo called: repo=${repo} by user=${fromId}`);
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
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot",
              "Content-Type": "application/json"
            },
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
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot",
              "Content-Type": "application/json"
            },
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
        console.log(`[SECURITY] delete_repo_file called: repo=${repo} path=${filePath} by user=${fromId}`);
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
            headers: {
              Authorization: `Bearer ${pat}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "telegram-ai-bot",
              "Content-Type": "application/json"
            },
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

      case "generate_pdf": {
        const title = args.title || "Dokumen";
        const content = args.content || "";
        if (!content) return "Konten dokumen tidak boleh kosong.";
        const fileName = args.filename || "document.html";
        const html = generatePdfHtml(title, markdownToHtml(content));
        const result = await sendTelegramDocument(env.TELEGRAM_TOKEN, chatId, fileName, html);
        if (!result.ok) return `\u274C Gagal mengirim dokumen: ${result.error}`;
        return `\u2705 Dokumen **${title}** berhasil dikirim. Buka file lalu klik tombol "Download PDF" untuk menyimpan.`;
      }

      case "cron_list": {
        if (!env.DB) return "D1 tidak tersedia.";
        const rows = await env.DB.prepare("SELECT id,cron_time,task_text,last_run,active FROM tasks WHERE owner_id=? AND type=? ORDER BY cron_time").bind(String(fromId), "cron").all();
        const list = (rows.results || [])
          .map(
            (t) =>
              "#" + t.id + " " + t.cron_time + " " + (t.active ? "[Aktif]" : "[Nonaktif]") + " " + t.task_text + (t.last_run ? " (terakhir: " + t.last_run.slice(0, 10) + ")" : " (belum jalan)")
          )
          .join("\n");
        return list || "Belum ada cron.";
      }

      case "cron_create": {
        const time = args.time;
        const task = args.task;
        if (!time || !/^\d{1,2}[:.]\d{2}$/.test(time)) return "Format waktu: HH:MM";
        if (!task || task.length < 3) return "Tugas terlalu pendek.";
        if (!env.DB) return "D1 tidak tersedia.";
        const cronTime = time.replace(".", ":");
        await env.DB.prepare("INSERT INTO tasks (owner_id,chat_id,type,cron_time,task_text,active,created_at) VALUES (?,?,?,?,?,1,?)").bind(
          String(fromId),
          String(chatId),
          "cron",
          cronTime,
          task,
          Date.now()
        ).run();
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
        await env.DB.prepare("INSERT INTO pending_reminders (owner_id,chat_id,remind_at,message,created_at) VALUES (?,?,?,?,?)").bind(
          String(fromId),
          String(chatId),
          remindAt,
          pesan,
          Date.now()
        ).run();
        const wib = new Date(remindAt + 7 * 3600000);
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
          return body.trim().slice(0, 8000) || "(Halaman kosong.)";
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
          return `**${fileName}:**\n\n${text.trim().slice(0, 15000)}`;
        } catch (err) {
          return `Gagal membaca dokumen: ${err.message}`;
        }
      }

      // --- Custom skill tools (dynamic from D1) ---
      case "create_skill": {
        const toolName = (args.tool_name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_");
        const description = args.description || "";
        const urlTemplate = args.url_template || "";
        if (!toolName || !description || !urlTemplate) return "tool_name, description, dan url_template wajib diisi.";
        if (!/^https:\/\//.test(urlTemplate)) return "URL harus diawali https://";
        const ok = await saveCustomTool(env, chatId, {
          tool_name: toolName,
          description,
          parameters: args.parameters || { type: "object", properties: {} },
          method: args.method || "GET",
          url_template: urlTemplate,
          headers: args.headers || null
        });
        if (!ok) return "Gagal menyimpan skill.";
        return `Skill "${tool_name}" berhasil dibuat! Sekarang bisa digunakan.`;
      }

      case "list_skills": {
        const tools = await getCustomTools(env, chatId);
        if (!tools.length) return "Belum ada skill custom.";
        return tools.map((t) => `- ${t.tool_name}: ${t.description} [${t.method} ${t.url_template.slice(0, 50)}]`).join("\n");
      }

      case "delete_skill": {
        const toolName = args.tool_name || "";
        if (!toolName) return "tool_name wajib diisi.";
        const deleted = await deleteCustomTool(env, chatId, toolName);
        return deleted ? `Skill "${toolName}" dihapus.` : `Skill "${toolName}" tidak ditemukan.`;
      }

      default:
        // Check if this is a dynamic custom tool (prefix: custom_)
        if (name.startsWith("custom_")) {
          const customName = name.slice(7); // remove "custom_" prefix
          const tools = await getCustomTools(env, chatId);
          const toolDef = tools.find((t) => t.tool_name === customName);
          if (!toolDef) return `Custom tool "${customName}" tidak ditemukan.`;
          return await executeCustomTool(toolDef, args);
        }
        return `Tool "${name}" tidak dikenal.`;
    }
  } catch (err) {
    console.error(`Tool ${name} error:`, err.message);
    return `Error saat menjalankan ${name}: ${err.message}`;
  }
}
