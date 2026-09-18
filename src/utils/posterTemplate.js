// src/utils/posterTemplate.js
// Generates a full-bleed poster/flyer as an HTML document (same delivery method
// as generate_pdf: send .html file, open in browser, print/Save-as-PDF button).
// Background photos come from Unsplash's free source-config endpoint and are
// rebuilt as imgix URLs (crop/fit/w/h/q params), per user's image policy.

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Search Unsplash's client-side API (no key required) and return the first
// photo as an imgix-cropped URL. Returns null if the network/search fails.
export async function findPosterImage(keyword, width, height) {
  const orient = width >= height ? "landscape" : "portrait";
  let pick = null;
  for (const url of [
    "https://unsplash.com/napi/search/photos?query=" + encodeURIComponent(keyword) + "&per_page=5&orientation=" + orient,
    "https://unsplash.com/napi/search/photos?query=" + encodeURIComponent(keyword) + "&per_page=5",
    "https://unsplash.com/napi/search/photos?query=" + encodeURIComponent(String(keyword).split(/\s+/)[0] || keyword) + "&per_page=5"
  ]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const results = (data && data.results) || [];
      pick = results.find((r) => !r.premium) || results[0] || null;
      if (pick) break;
    } catch {
      // try next fallback query
    }
  }
  if (!pick || !pick.urls || !pick.urls.raw) return null;
  const raw = pick.urls.raw;
  const base = raw.split("?")[0];
  const params = new URLSearchParams();
  params.set("crop", "entropy");
  params.set("cs", "tinysrgb");
  params.set("fit", "crop");
  params.set("fm", "jpg");
  params.set("w", String(width));
  params.set("h", String(height));
  params.set("q", "85");
  const q = raw.split("?")[1] || "";
  for (const kv of q.split("&")) {
    const [k, v] = kv.split("=");
    if (k === "ixid") params.set(k, v || "");
  }
  return {
    url: base + "?" + params.toString(),
    author: (pick.user && pick.user.name) || "Unsplash",
    authorLink: pick.links ? pick.links.html : "https://unsplash.com"
  };
}

// Solid gradient fallback when no photo is found.
function fallbackGradient(accent) {
  return `linear-gradient(160deg, ${accent} 0%, #10131a 70%)`;
}

/**
 * args: { layout, title, subtitle, details[], cta, accent, imageKeyword, bgImage }
 * layout: "poster" (portrait A4-ish) | "flyer" (landscape)
 * bgImage: optional data URL from the user's uploaded image (stored in D1).
 *          When present it is used directly and the Unsplash/imgix lookup is
 *          skipped.
 */
export async function generatePosterHtml(args) {
  const layout = args.layout === "flyer" ? "flyer" : "poster";
  const [W, H] = layout === "flyer" ? [1414, 1000] : [1000, 1414];
  const accent = /^#[0-9a-fA-F]{6}$/.test(args.accent || "") ? args.accent : "#ff5a5f";
  const photo = args.bgImage
    ? { url: args.bgImage, author: null, authorLink: null }
    : await findPosterImage(args.imageKeyword || args.title || "event", W, H);

  const detailsHtml = (args.details || [])
    .map((d) => {
      const s = String(d).trim();
      if (!s) return "";
      if (/^https?:\/\//i.test(s)) return `<a class="dlink" href="${escapeHtml(s)}" target="_blank">${escapeHtml(s)}</a>`;
      return `<div class="dline">${escapeHtml(s)}</div>`;
    })
    .filter(Boolean)
    .join("");

  const bg = photo
    ? `url("${photo.url}") center/cover no-repeat`
    : fallbackGradient(accent);

  const isUnsplash = !!(photo && photo.author);
  const credit = isUnsplash
    ? `Photo: <a href="${escapeHtml(photo.authorLink)}" target="_blank">${escapeHtml(photo.author)}</a> / Unsplash · `
    : "";

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(args.title || "Poster")}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #0b0d12; }
  body {
    font-family: 'Segoe UI', system-ui, -apple-system, Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center;
    padding: 16px 16px 84px;
  }
  .sheet {
    position: relative;
    width: ${W}px; height: ${H}px;
    max-width: 100%;
    background: ${bg}, #0b0d12;
    display: flex; flex-direction: column; justify-content: flex-end;
    color: #fff; overflow: hidden;
    box-shadow: 0 12px 48px rgba(0,0,0,.6);
  }
  .scrim {
    position: absolute; inset: 0;
    background: linear-gradient(180deg, rgba(10,12,16,.55) 0%, rgba(10,12,16,.15) 38%, rgba(10,12,16,.92) 100%);
  }
  .inner { position: relative; padding: clamp(24px, 5%, 56px); }
  .bar { width: 72px; height: 8px; border-radius: 4px; background: ${accent}; margin-bottom: 18px; }
  h1 { font-size: ${layout === "flyer" ? "56px" : "68px"}; line-height: 1.08; letter-spacing: -1px; text-transform: uppercase; font-weight: 900; text-shadow: 0 3px 18px rgba(0,0,0,.7); }
  .sub { font-size: 26px; font-weight: 600; color: #eef1f6; margin-top: 10px; text-shadow: 0 2px 10px rgba(0,0,0,.7); }
  .details { margin-top: 18px; font-size: 21px; line-height: 1.55; text-shadow: 0 2px 8px rgba(0,0,0,.8); }
  .dline { padding: 3px 0; }
  .dline::before { content: "•"; color: ${accent}; font-weight: 900; display: inline-block; width: 1.1em; }
  .dlink { color: #bfe3ff; word-break: break-all; }
  .cta {
    display: inline-block; margin-top: 26px;
    background: ${accent}; color: #fff; text-decoration: none;
    font-size: 24px; font-weight: 800; letter-spacing: .5px;
    padding: 16px 34px; border-radius: 999px;
    box-shadow: 0 8px 28px rgba(0,0,0,.45);
  }
  .credit { position: absolute; right: 10px; top: 10px; font-size: 11px; color: rgba(255,255,255,.65); background: rgba(0,0,0,.35); padding: 3px 8px; border-radius: 6px; }
  .credit a { color: #cfe3ff; text-decoration: none; }
  .download-btn {
    position: fixed; bottom: 24px; right: 24px;
    background: ${accent}; color: #fff; border: none;
    padding: 14px 28px; border-radius: 30px;
    font-size: 16px; font-weight: bold;
    box-shadow: 0 4px 16px rgba(0,0,0,.4); z-index: 99999; cursor: pointer;
  }
  @media print {
    @page { size: ${layout === "flyer" ? "A4 landscape" : "A4 portrait"}; margin: 0; }
    body { padding: 0; background: #fff; }
    .sheet { box-shadow: none; max-width: none; }
    .download-btn { display: none !important; }
    .credit { display: none !important; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
  @media (max-width: ${W + 40}px) {
    .sheet { width: 100%; height: auto; aspect-ratio: ${W}/${H}; }
    h1 { font-size: clamp(28px, 8.5vw, 68px); }
    .sub { font-size: clamp(14px, 3.4vw, 26px); }
    .details { font-size: clamp(12px, 2.9vw, 21px); }
    .cta { font-size: clamp(13px, 3.2vw, 24px); padding: 10px 22px; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="scrim"></div>
  ${isUnsplash ? `<div class="credit">${credit}imgix</div>` : ""}
  <div class="inner">
    <div class="bar"></div>
    <h1>${escapeHtml(args.title || "Poster")}</h1>
    ${args.subtitle ? `<div class="sub">${escapeHtml(args.subtitle)}</div>` : ""}
    ${detailsHtml ? `<div class="details">${detailsHtml}</div>` : ""}
    ${args.cta ? `<div><span class="cta">${escapeHtml(args.cta)}</span></div>` : ""}
  </div>
</div>
<button class="download-btn" onclick="window.print()">&#11015; Save PDF / Gambar</button>
</body>
</html>`;
}
