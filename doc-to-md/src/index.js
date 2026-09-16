// doc-to-md/src/index.js
// Document to Markdown converter worker
// Accepts file bytes via POST, returns extracted text as markdown.

import { extractDocumentText } from "./documents.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      const body = await request.json();
      const { file_name, mime_type, file_bytes } = body;

      if (!file_bytes) {
        return new Response(JSON.stringify({ error: "Missing file_bytes" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      // Decode base64 to Uint8Array
      const binaryStr = atob(file_bytes);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const text = await extractDocumentText(env, bytes, file_name || "document", mime_type || "");

      return new Response(JSON.stringify({ text }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};
