// src/ocr.js
// OCR capability using Cloudflare Workers AI vision model.
// Used when PDF/DOCX text extraction returns minimal text (scanned documents).

/**
 * Use Cloudflare Workers AI to extract text from an image (Uint8Array).
 * @param {object} env - Worker env with AI binding
 * @param {Uint8Array} imageData - Raw image bytes (PNG/JPEG)
 * @param {string} filename - Original filename for context
 * @returns {Promise<string|null>} Extracted text or null
 */
export async function ocrImage(env, imageData, filename) {
  if (!env.AI) {
    console.error("OCR skipped: AI binding not available");
    return null;
  }

  try {
    const blob = new Blob([imageData], { type: "image/png" });
    const result = await env.AI.run(
      "@cf/microsoft/resnet-50",
      { image: blob }
    );

    if (!result || !result.choices || !result.choices[0]) {
      return null;
    }

    // Vision model returns description - use it as OCR result
    const description = result.choices[0].message?.content || "";
    return description.trim() || null;
  } catch (err) {
    console.error("OCR vision error:", err.message);
    return null;
  }
}

/**
 * Use Cloudflare Workers AI to extract text from a document page.
 * Falls back to describing the document content.
 * @param {object} env - Worker env with AI binding
 * @param {Uint8Array} documentData - Raw document bytes
 * @param {string} mimeType - MIME type of the document
 * @param {string} filename - Original filename
 * @returns {Promise<string|null>} Extracted text or null
 */
export async function ocrDocument(env, documentData, mimeType, filename) {
  if (!env.AI) {
    console.error("OCR skipped: AI binding not available");
    return null;
  }

  try {
    // Convert to base64 for AI model
    let binary = "";
    const bytes = new Uint8Array(documentData);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    // Use @cf/meta/llama-3.2-11b-vision-instruct for document understanding
    const result = await env.AI.run(
      "@cf/meta/llama-3.2-11b-vision-instruct",
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: `data:${mimeType};base64,${base64}`
              },
              {
                type: "text",
                text: "Extract ALL text from this document image. Return the text exactly as it appears, preserving formatting and structure. If there are tables, convert them to plain text. Do not add any commentary."
              }
            ]
          }
        ],
        max_tokens: 4000
      }
    );

    if (!result || !result.choices || !result.choices[0]) {
      return null;
    }

    const text = result.choices[0].message?.content || "";
    return text.trim() || null;
  } catch (err) {
    console.error("OCR document error:", err.message);
    return null;
  }
}
