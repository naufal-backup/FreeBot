// src/tools/executor.js
// Executes a single tool call requested by the AI model and returns a
// string result to feed back into the conversation.

import { fmtBytes } from "../utils/format.js";
import { parseNaturalTime } from "../utils/time.js";
import { markdownToHtml } from "../utils/markdown.js";
import { generatePdfHtml } from "../utils/pdfTemplate.js";
import { generatePosterHtml } from "../utils/posterTemplate.js";
import { sendTelegramDocument } from "../telegram.js";
import { extractDocumentText } from "../documents.js";
import { setPendingAction } from "../pendingActions.js";
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
import { getGoogleAccessToken, createGoogleDoc, readGoogleDoc, appendGoogleDoc, shareGoogleDoc, extractDocIdFromUrl, isPermissionError, permissionDeniedHint, extractSheetIdFromUrl, createGoogleSheet, readGoogleSheet, writeGoogleSheet, appendGoogleSheet } from "../google.js";
import { getImage, listImages, deleteImage, deleteAllImages } from "../imageStore.js";

// Escape a string for safe use inside an HTML attribute value.
function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

// Convert a 1-based column index to a spreadsheet letter (1->A, 27->AA).
function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Normalize tool `values` into a 2D array (array of row arrays).
function normalizeValues(parsed) {
  if (!Array.isArray(parsed)) return [[String(parsed)]];
  if (parsed.length === 0) return [];
  if (!Array.isArray(parsed[0])) return [parsed]; // single row given flat
  return parsed;
}

// Highest 1-based row index that contains any non-empty cell.
function lastFilledRow(rows) {
  let last = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Array.isArray(r) && r.some((c) => c !== "" && c != null)) last = i + 1;
  }
  return last;
}

// First integer in an A1-style range = start row ("A27:E46" -> 27, "A:Z" -> 1).
function parseStartRow(range) {
  const r = String(range || "");
  const cellPart = r.includes("!") ? r.split("!").pop() : r; // drop sheet prefix
  const m = cellPart.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

// Build the empty-row check + confirmation text for a write/append.
// Returns { confirm, range } where `range` is stored in the pending action.
async function buildSheetWriteConfirm(token, sheetId, values, reqRange, mode) {
  // Read the whole used area (cols A:Z) to locate filled rows.
  const full = await readGoogleSheet(token, sheetId, "A:Z");
  const filled = lastFilledRow(full.rows || []);
  const sheetName = full.sheetName || "Sheet1";

  const width = values.reduce((mx, r) => Math.max(mx, r.length), 1);
  const lastCol = colLetter(width);
  const n = values.length;

  let startRow;
  let targetRange;
  let overlapWarning = "";
  const cellPartReq = reqRange && reqRange.includes("!") ? reqRange.split("!").pop() : reqRange;
  const explicit = cellPartReq && /\d/.test(cellPartReq); // "A27:E46" yes, "A:Z" no
  if (explicit) {
    startRow = parseStartRow(reqRange);
    targetRange = reqRange.includes("!") ? reqRange.split("!").pop() : reqRange;
    const endRow = startRow + n - 1;
    if (startRow <= filled) {
      overlapWarning = `\n⚠️ Baris ${startRow}-${Math.min(endRow, filled)} sudah terisi — data lama akan TIMPA.`;
    }
  } else {
    // Auto-place after the last filled row.
    startRow = filled + 1;
    targetRange = `A${startRow}:${lastCol}${startRow + n - 1}`;
  }

  // Preview: first 3 rows with their target row numbers.
  let preview = "";
  for (let i = 0; i < Math.min(3, n); i++) {
    const cells = values[i].map((c) => String(c));
    let line = cells.join(" | ");
    if (line.length > 60) line = line.slice(0, 57) + "...";
    preview += `${startRow + i}: ${line}\n`;
  }
  if (n > 3) preview += `... +${n - 3} baris lagi\n`;

  const verb = mode === "append" ? "APPEND" : "TULIS";
  let confirm = `⚠️ Konfirmasi ${verb} ke spreadsheet:\n`;
  confirm += `📄 Sheet: ${sheetName}\n`;
  confirm += `📊 Baris terisi: ${filled}\n`;
  confirm += `📍 Target: ${targetRange} (${n} baris)\n`;
  if (overlapWarning) confirm += overlapWarning;
  confirm += `\n${preview}\n`;
  confirm += `Cek ulang — ketik "ya" untuk lanjut atau "batal" untuk batalkan.`;

  return { confirm, sheetName, targetRange };
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

      case "commit_image_to_repo": {
        const repo = args.repo;
        const imageId = args.image_id;
        const path = args.path;
        if (!repo || !imageId || !path) return "repo, image_id, dan path harus diisi.";
        console.log(`[SECURITY] commit_image_to_repo called: repo=${repo} path=${path} by user=${fromId}`);
        if (!env.DB) return "D1 tidak tersedia.";
        const img = await getImage(env, imageId, chatId);
        if (!img) return `Gambar id=${imageId} tidak ditemukan atau sudah kedaluwarsa. Minta user kirim ulang gambarnya.`;
        const pat = await getServiceToken(env, fromId, "github");
        if (!pat) return "GitHub belum tersambung. Gunakan /login-gh dulu.";
        const githubLogin = await validateGithubToken(pat);
        if (!githubLogin) return "Token GitHub tidak valid.";
        try {
          await pullRepo(pat, repo, "main");
        } catch (e) {
          return `Pull gagal: ${e.message}. Commit dibatalkan.`;
        }
        // Commit binary content as base64 (commitToRepo honors f.encoding).
        await commitToRepo(pat, repo, args.message || `Add ${path}`, [{ path, content: img.dataB64, encoding: "base64" }], "main");
        // Auto-delete the image from D1 after a successful commit.
        await deleteImage(env, imageId, chatId);
        return `\u2705 Gambar **${img.fileName}** (${fmtBytes(img.sizeBytes)}) di-commit ke ${repo} sebagai \`${path}\`. Gambar sudah dihapus dari penyimpanan sementara.`;
      }

      case "list_images": {
        const imgs = await listImages(env, chatId);
        if (!imgs.length) return "Belum ada gambar tersimpan. Kirim gambar ke chat untuk menyimpannya sementara (kadaluarsa 30 menit).";
        const lines = imgs.map((im) => `- id=${im.id} | ${im.fileName} | ${fmtBytes(im.sizeBytes)}`);
        return `Gambar tersimpan (${imgs.length}):\n${lines.join("\n")}\n\nPakai id di generate_poster/generate_pdf (image_id) atau commit_image_to_repo.`;
      }

      case "delete_image": {
        const imageId = args.image_id;
        if (!imageId) return "image_id harus diisi.";
        const before = await listImages(env, chatId);
        const exists = before.some((im) => im.id === imageId);
        if (!exists) return `Gambar id=${imageId} tidak ditemukan (mungkin sudah dihapus/kedaluwarsa).`;
        await deleteImage(env, imageId, chatId);
        return `\u2705 Gambar id=${imageId} dihapus dari penyimpanan sementara.`;
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
        let bodyHtml = markdownToHtml(content);
        // Optional user-uploaded image embedded at the top of the document.
        if (args.image_id) {
          const img = await getImage(env, args.image_id, chatId);
          if (img) {
            bodyHtml = `<div style="text-align:center;margin:0 0 1.5em"><img src="${img.dataUrl}" alt="${escapeAttr(img.fileName)}" style="max-width:100%;height:auto;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.18)"></div>` + bodyHtml;
          }
        }
        const html = generatePdfHtml(title, bodyHtml);
        const result = await sendTelegramDocument(env.TELEGRAM_TOKEN, chatId, fileName, html);
        if (!result.ok) return `\u274C Gagal mengirim dokumen: ${result.error}`;
        // Auto-delete the used image so D1 doesn't fill up.
        if (args.image_id) await deleteImage(env, args.image_id, chatId);
        return `\u2705 Dokumen **${title}** berhasil dikirim. Buka file lalu klik tombol "Download PDF" untuk menyimpan.${args.image_id ? " Gambar sudah dihapus dari penyimpanan sementara." : ""}`;
      }

      case "generate_poster": {
        const title = args.title || "Poster";
        const layout = args.layout === "flyer" ? "flyer" : "poster";
        let details = args.details;
        if (typeof details === "string") {
          try { details = JSON.parse(details); } catch { details = details.split(/\n|;/).map((s) => s.trim()).filter(Boolean); }
        }
        if (!Array.isArray(details)) details = details ? [String(details)] : [];
        // If the user uploaded an image, use it as the background; otherwise
        // fall back to an Unsplash/imgix lookup by keyword.
        let bgImage = null;
        let usedImageId = null;
        let sourceNote = "";
        if (args.image_id) {
          const img = await getImage(env, args.image_id, chatId);
          if (img) {
            bgImage = img.dataUrl;
            usedImageId = args.image_id;
            sourceNote = `gambar milikmu "${img.fileName}"`;
          } else {
            sourceNote = `gambar id=${args.image_id} tidak ditemukan (kedaluwarsa?), pakai Unsplash`;
          }
        }
        const keyword = args.imageKeyword || title;
        const fileName = (layout + "-" + (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "poster")) + ".html";
        const html = await generatePosterHtml({
          layout,
          title,
          subtitle: args.subtitle,
          details: details.slice(0, 6),
          cta: args.cta,
          accent: args.accent,
          bgImage,
          imageKeyword: bgImage ? undefined : keyword
        });
        const result = await sendTelegramDocument(env.TELEGRAM_TOKEN, chatId, fileName, html);
        if (!result.ok) return `\u274C Gagal mengirim poster: ${result.error}`;
        // Auto-delete the used image so D1 doesn't fill up.
        if (usedImageId) await deleteImage(env, usedImageId, chatId);
        const src = bgImage ? sourceNote : `Unsplash "${keyword}"`;
        return `\u2705 ${layout === "flyer" ? "Flyer" : "Poster"} **${title}** terkirim (gambar: ${src}). Buka file di browser — tombol "Save PDF / Gambar" untuk simpan/cetak.${usedImageId ? " Gambar sudah dihapus dari penyimpanan sementara." : " Ganti gambar? Bilang saja keyword lain."}`;
      }

      case "google_create_doc": {
        const docTitle = args.title || "Dokumen Baru";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi. Set secret GOOGLE_SERVICE_ACCOUNT.";
        try {
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          const doc = await createGoogleDoc(token, docTitle);
          return `\u2705 Dokumen berhasil dibuat!\n\n**${doc.title}**\n${doc.url}`;
        } catch (e) {
          return `\u274C Gagal buat dokumen: ${e.message}`;
        }
      }

      case "google_read_doc": {
        const docId = extractDocIdFromUrl(args.document_id || args.url || args.link);
        if (!docId) return "document_id tidak valid. Kirim link Google Docs atau document_id.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          const doc = await readGoogleDoc(token, docId);
          return `**${doc.title}**\n\n${doc.content.slice(0, 8000)}`;
        } catch (e) {
          if (isPermissionError(e.message)) return permissionDeniedHint();
          return `\u274C Gagal baca dokumen: ${e.message}`;
        }
      }

      case "google_append_doc": {
        const docId = extractDocIdFromUrl(args.document_id || args.url || args.link);
        const text = args.text;
        if (!docId || !text) return "document_id dan text harus diisi.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          await appendGoogleDoc(token, docId, text);
          const url = `https://docs.google.com/document/d/${docId}/edit`;
          return `\u2705 Teks berhasil ditambahkan ke dokumen.\n${url}`;
        } catch (e) {
          if (isPermissionError(e.message)) return permissionDeniedHint();
          return `\u274C Gagal append: ${e.message}`;
        }
      }

      case "google_share_doc": {
        const docId = extractDocIdFromUrl(args.document_id || args.url || args.link);
        const email = args.email;
        const role = args.role || "reader";
        if (!docId || !email) return "document_id dan email harus diisi.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          await shareGoogleDoc(token, docId, email, role);
          return `\u2705 Dokumen berhasil di-share ke ${email} (${role})`;
        } catch (e) {
          if (isPermissionError(e.message)) return permissionDeniedHint();
          return `\u274C Gagal share: ${e.message}`;
        }
      }

      case "google_create_sheet": {
        const sheetTitle = args.title || "Spreadsheet Baru";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";

        setPendingAction(chatId, {
          type: "google_create_sheet",
          args: { title: sheetTitle }
        });

        let confirm = `⚠️ Konfirmasi BUAT spreadsheet baru:\n`;
        confirm += `📄 Judul: ${sheetTitle}\n`;
        confirm += `\nKetik "ya" untuk lanjut atau "batal" untuk batalkan.`;
        return confirm;
      }

      case "google_read_sheet": {
        const sheetId = extractSheetIdFromUrl(args.spreadsheet_id || args.url || args.link);
        if (!sheetId) return "spreadsheet_id tidak valid. Kirim link Google Sheets atau spreadsheet_id.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          const data = await readGoogleSheet(token, sheetId, args.range);
          if (!data.rows.length) return "Spreadsheet kosong.";
          const header = data.rows[0] || [];
          const rows = data.rows.slice(1);
          let output = `**${data.title}**\n\n`;
          output += `Kolom: ${header.join(" | ")}\n`;
          output += `${"-".repeat(40)}\n`;
          for (const row of rows.slice(0, 50)) {
            output += row.join(" | ") + "\n";
          }
          if (rows.length > 50) output += `\n... dan ${rows.length - 50} baris lagi`;
          return output;
        } catch (e) {
          if (isPermissionError(e.message)) return permissionDeniedHint();
          return `\u274C Gagal baca spreadsheet: ${e.message}`;
        }
      }

      case "google_write_sheet": {
        const sheetId = extractSheetIdFromUrl(args.spreadsheet_id || args.url || args.link);
        const values = args.values;
        if (!sheetId || !values) return "spreadsheet_id dan values harus diisi.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const parsed = typeof values === "string" ? JSON.parse(values) : values;
          const norm = normalizeValues(parsed);
          if (!norm.length) return "values kosong — tidak ada yang ditulis.";
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          const { confirm, sheetName, targetRange } = await buildSheetWriteConfirm(token, sheetId, norm, args.range, "write");

          setPendingAction(chatId, {
            type: "google_write_sheet",
            args: { spreadsheet_id: sheetId, range: `${sheetName}!${targetRange}`, values: norm }
          });

          return confirm;
        } catch (e) {
          return `\u274C Gagal siapkan tulis: ${e.message}`;
        }
      }

      case "google_append_sheet": {
        const sheetId = extractSheetIdFromUrl(args.spreadsheet_id || args.url || args.link);
        const values = args.values;
        if (!sheetId || !values) return "spreadsheet_id dan values harus diisi.";
        if (!env.GOOGLE_SERVICE_ACCOUNT) return "Google Service Account belum dikonfigurasi.";
        try {
          const parsed = typeof values === "string" ? JSON.parse(values) : values;
          const norm = normalizeValues(parsed);
          if (!norm.length) return "values kosong — tidak ada yang ditambahkan.";
          const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
          const { confirm, sheetName, targetRange } = await buildSheetWriteConfirm(token, sheetId, norm, args.range, "append");

          setPendingAction(chatId, {
            type: "google_append_sheet",
            args: { spreadsheet_id: sheetId, range: `${sheetName}!${targetRange}`, values: norm }
          });

          return confirm;
        } catch (e) {
          return `\u274C Gagal siapkan append: ${e.message}`;
        }
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

export async function executePendingAction(action, env, chatId) {
  try {
    const token = await getGoogleAccessToken(env.GOOGLE_SERVICE_ACCOUNT);
    if (action.type === "google_write_sheet") {
      const { spreadsheet_id, range, values } = action.args;
      const result = await writeGoogleSheet(token, spreadsheet_id, range, values);
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`;
      return `\u2705 Berhasil tulis ${result.updatedCells} sel ke spreadsheet.\n${url}`;
    }
    if (action.type === "google_append_sheet") {
      const { spreadsheet_id, range, values } = action.args;
      const result = await appendGoogleSheet(token, spreadsheet_id, range, values);
      const url = `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`;
      return `\u2705 Berhasil append ${result.updatedCells} sel ke spreadsheet.\n${url}`;
    }
    if (action.type === "google_create_sheet") {
      const sheet = await createGoogleSheet(token, action.args.title);
      return `\u2705 Spreadsheet berhasil dibuat!\n\n**${sheet.title}**\n${sheet.url}`;
    }
    return "Action tidak dikenal.";
  } catch (e) {
    return `\u274C Gagal eksekusi: ${e.message}`;
  }
}
