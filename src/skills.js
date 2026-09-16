// src/skills.js
// Custom skill CRUD and dynamic tool builder.
// Allows users to create API-call tools via natural language.

/**
 * Save a custom tool definition to D1.
 * @param {D1Database} db
 * @param {string} chatId
 * @param {object} toolDef - { tool_name, description, parameters, method, url_template, headers }
 */
export async function saveCustomTool(env, chatId, toolDef) {
  if (!env.DB) return false;
  const { tool_name, description, parameters, method, url_template, headers } = toolDef;
  if (!tool_name || !description || !url_template) return false;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO custom_tools (chat_id, tool_name, description, parameters, method, url_template, headers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      String(chatId),
      tool_name,
      description,
      JSON.stringify(parameters || { type: "object", properties: {} }),
      method || "GET",
      url_template,
      headers ? JSON.stringify(headers) : null
    )
    .run();
  return true;
}

/**
 * Get all custom tools for a chat.
 * @returns {Array<object>}
 */
export async function getCustomTools(env, chatId) {
  if (!env.DB) return [];
  const rows = await env.DB.prepare(
    "SELECT tool_name, description, parameters, method, url_template, headers FROM custom_tools WHERE chat_id = ? ORDER BY created_at"
  )
    .bind(String(chatId))
    .all();
  return (rows.results || []).map((r) => ({
    ...r,
    parameters: JSON.parse(r.parameters || "{}"),
    headers: r.headers ? JSON.parse(r.headers) : null
  }));
}

/**
 * Delete a custom tool by name.
 */
export async function deleteCustomTool(env, chatId, toolName) {
  if (!env.DB) return false;
  const result = await env.DB.prepare("DELETE FROM custom_tools WHERE chat_id = ? AND tool_name = ?")
    .bind(String(chatId), toolName)
    .run();
  return result.meta?.changes > 0;
}

/**
 * Build OpenAI function-calling tool schemas from custom tools.
 */
export function buildDynamicToolSchemas(customTools) {
  return customTools.map((t) => ({
    type: "function",
    function: {
      name: `custom_${t.tool_name}`,
      description: t.description,
      parameters: t.parameters || { type: "object", properties: {} }
    }
  }));
}

/**
 * Execute a custom tool by fetching the URL with parameter substitution.
 * @param {object} toolDef - the custom tool row from D1
 * @param {object} args - tool call arguments
 * @returns {Promise<string>}
 */
export async function executeCustomTool(toolDef, args) {
  let url = toolDef.url_template;
  const params = toolDef.parameters?.properties || {};
  const required = toolDef.parameters?.required || [];

  for (const [key, val] of Object.entries(args)) {
    url = url.replace(new RegExp(`\\{${key}\\}`, "g"), encodeURIComponent(String(val)));
  }

  for (const key of required) {
    if (!(key in args) || args[key] === undefined || args[key] === "") {
      return `Parameter "${key}" wajib diisi.`;
    }
  }

  const headers = { "User-Agent": "telegram-ai-bot/1.0" };
  if (toolDef.headers) {
    Object.assign(headers, toolDef.headers);
  }

  try {
    const fetchOpts = { method: toolDef.method || "GET", headers };
    if (toolDef.method !== "GET" && toolDef.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(args);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, fetchOpts);
    if (!res.ok) return `HTTP ${res.status}: ${res.statusText}`;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const data = await res.json();
      return JSON.stringify(data, null, 2).slice(0, 8000);
    }
    const text = await res.text();
    return text.slice(0, 8000) || "(Respons kosong)";
  } catch (err) {
    return `Gagal mengakses ${url}: ${err.message}`;
  }
}
