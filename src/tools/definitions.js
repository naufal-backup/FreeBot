// src/tools/definitions.js
// OpenAI-compatible function-calling tool schema exposed to the AI model.
// Includes both static tools and dynamic custom tools from D1.

import { getCustomTools, buildDynamicToolSchemas } from "../skills.js";

export const TOOL_DEFINITIONS = [
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
      name: "generate_pdf",
      description: 'Buat dokumen HTML dengan tombol download PDF. Panggil saat user minta "buat essay", "buat pdf", "buat artikel", "buat laporan", "buat dokumen".',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Judul dokumen" },
          content: { type: "string", description: "Isi dokumen dalam format markdown" },
          filename: { type: "string", description: "Nama file (default: document.html)" }
        },
        required: ["title", "content"]
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

/**
 * Merge static tool definitions with dynamic custom tools from D1.
 * @param {D1Database} db
 * @param {string} chatId
 * @returns {Promise<Array>} combined tool schemas for OpenAI API
 */
export async function getAllToolDefinitions(env, chatId) {
  const customTools = await getCustomTools(env, chatId);
  const dynamicSchemas = buildDynamicToolSchemas(customTools);
  return [...TOOL_DEFINITIONS, ...dynamicSchemas];
}
