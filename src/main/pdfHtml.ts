import type { Block, Run } from "../shared/showNotes";

/**
 * The document model as a standalone, print-ready HTML page, for PDF export.
 * Mirrors the Word writer (src/main/docx.ts): same headings, lists, tables,
 * quotes and link handling, on a Letter page with 1" margins.
 */

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function run(r: Run): string {
  let html = escapeHtml(r.text);
  const url = r.text.trim();
  // A bare URL becomes a clickable link, as in the Word export.
  if (/^https?:\/\/\S+$/.test(url)) html = `<a href="${escapeHtml(url)}">${html}</a>`;
  if (r.bold) html = `<b>${html}</b>`;
  if (r.italic) html = `<i>${html}</i>`;
  // Confidence colors are for the Word transcript only (see Settings), so a PDF, like plain text, has none.
  return html;
}

const runs = (rs: Run[]) => rs.map(run).join("");

function block(b: Block): string {
  switch (b.type) {
    case "heading":
      return `<h${b.level}>${escapeHtml(b.text)}</h${b.level}>`;
    case "paragraph":
      return `<p>${runs(b.runs)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag}>${b.items.map((item) => `<li>${runs(item)}</li>`).join("")}</${tag}>`;
    }
    case "table":
      return (
        `<table><thead><tr>${b.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>` +
        `<tbody>${b.rows.map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
    case "quote":
      return `<blockquote><p class="quote">“${escapeHtml(b.text)}”</p><p class="attribution">— ${escapeHtml(b.attribution)}</p></blockquote>`;
    case "rule":
      return "<hr>";
  }
}

const STYLE = `
@page { size: Letter; margin: 1in; }
html { font-family: Calibri, Carlito, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.35; color: #000; }
body { margin: 0; }
h1 { font-size: 18pt; margin: 0 0 6pt; }
h2 { font-size: 14pt; margin: 14pt 0 4pt; }
h3 { font-size: 12pt; margin: 10pt 0 3pt; }
h1, h2, h3 { break-after: avoid; }
p { margin: 0 0 6pt; }
ul, ol { margin: 0 0 6pt; padding-left: 0.4in; }
li { margin-bottom: 2pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 8pt; }
th, td { border: 0.5pt solid #bfbfbf; padding: 2pt 5pt; text-align: left; vertical-align: top; }
tr { break-inside: avoid; }
blockquote { margin: 0 0 6pt 0.4in; break-inside: avoid; }
blockquote .quote { font-style: italic; margin: 0; }
blockquote .attribution { color: #595959; }
hr { border: 0; border-bottom: 0.75pt solid #bfbfbf; margin: 8pt 0; }
a { color: #0563c1; }
`;

/** A complete HTML page for one document. Nothing in it loads from anywhere. */
export function blocksToHtml(blocks: Block[], title: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body>${blocks.map(block).join("\n")}</body></html>`
  );
}
