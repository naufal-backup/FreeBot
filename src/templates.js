// src/templates.js
// Generates the file set for a new project scaffold (worker-hello,
// worker-api, ai-chat), ready to push to a fresh GitHub repo.

export function renderTemplate(tpl, repoName) {
  const files = [];
  const put = (path, content) =>
    files.push({ path, content, size: new TextEncoder().encode(content).length });

  if (tpl === "worker-hello") {
    put(
      "wrangler.toml",
      `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true
`
    );
    put(
      "src/index.js",
      `/**
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
`
    );
    put(
      "package.json",
      `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`
    );
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "worker-api") {
    put(
      "wrangler.toml",
      `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true
`
    );
    put(
      "src/index.js",
      `/**
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
`
    );
    put(
      "package.json",
      `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`
    );
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else if (tpl === "ai-chat") {
    put(
      "wrangler.toml",
      `name = "${repoName}"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "${repoName}"
database_id = "CHANGE_ME"
`
    );
    put(
      "src/index.js",
      `/**
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
`
    );
    put(
      "package.json",
      `{
  "name": "${repoName}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  }
}
`
    );
    put(".gitignore", ".wrangler/\nnode_modules/\n.dev.vars\n");
  } else {
    return null;
  }

  return files;
}
