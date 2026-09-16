// src/utils/markdown.js
// Converts a (loose) Markdown subset into Telegram-compatible HTML,
// including a monospace fallback for tables.

export function markdownToHtml(text) {
  if (!text) return "";
  let s = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const protectedBlocks = [];

  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
    protectedBlocks.push(`<pre><code>${code}</code></pre>`);
    return `\0BLOCK${protectedBlocks.length - 1}\0`;
  });
  s = s.replace(/`([^`]+)`/g, (m, code) => {
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

  s = s.replace(/\u0000BLOCK(\d+)\u0000/g, (m, i) => protectedBlocks[Number(i)] || m);

  return s;
}

export function convertMarkdownTables(s) {
  const lines = s.split("\n");
  const out = [];
  let i = 0;

  const isSepRow = (line) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line.trim()) || line.trim().startsWith("|");

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

export function splitPipeRow(line) {
  let l = line.trim();
  l = l.replace(/^\|/, "").replace(/\|$/, "");
  return l.split("|").map((c) => c.trim());
}

export function formatTableMonospace(rows) {
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    widths.push(Math.max(...rows.map((r) => (r[c] || "").length)));
  }
  const header = rows[0];
  const body = rows.slice(1);
  const fmt = (cells) =>
    cells
      .map((cell, c) => String(cell || "").padEnd(widths[c], " "))
      .join(" | ")
      .replace(/\s+$/, "");
  const lines = [];
  lines.push(fmt(header.map((c) => `**${c}**`)));
  for (const r of body) lines.push(fmt(r));
  return `<pre><code>${lines.join("\n")}</code></pre>`;
}
