import type { Block, Run } from "../shared/showNotes";
import { fitInside, type DocBranding, type LogoImage } from "./brandingDoc";

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

const dataUrl = (image: LogoImage) => `data:image/png;base64,${Buffer.from(image.png).toString("base64")}`;

/** Text as a CSS string. "<" is escaped too, so nothing can close the style element. */
const cssString = (s: string) =>
  `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/</g, "\\3C ").replace(/[\r\n]+/g, " ")}"`;

const MARGIN_TEXT = "font-family: Calibri, Carlito, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 9pt; color: #595959;";

/**
 * Header and footer as CSS page margin boxes, so the cover page (the first)
 * can go without them. The small logo is declared at 3x so it prints sharp
 * at about 0.4" tall.
 */
function pageStyle(b: DocBranding): string {
  const boxes: string[] = [];
  if (b.headerLogo && b.logo) boxes.push(`@top-left { content: image-set(url("${dataUrl(b.logo.small)}") 3x); vertical-align: bottom; padding-bottom: 10pt; }`);
  if (b.headerText) boxes.push(`@top-right { content: ${cssString(b.headerText)}; ${MARGIN_TEXT} vertical-align: bottom; padding-bottom: 10pt; }`);
  if (b.footerText) boxes.push(`@bottom-left { content: ${cssString(b.footerText)}; ${MARGIN_TEXT} vertical-align: top; }`);
  if (b.pageNumbers) {
    boxes.push(`@bottom-right { content: "Page " counter(page) " of " counter(pages); ${MARGIN_TEXT} vertical-align: top; }`);
  }
  if (!boxes.length) return "";
  const none = ["top-left", "top-right", "bottom-left", "bottom-right"].map((m) => `@${m} { content: none; }`).join(" ");
  return `@page { ${boxes.join(" ")} }` + (b.cover ? ` @page :first { ${none} }` : "");
}

const COVER_STYLE = `
.cover { break-after: page; text-align: center; padding-top: 1.75in; }
.cover img { display: block; margin: 0 auto 0.45in; }
.cover .show { font-size: 28pt; font-weight: bold; margin: 0 0 12pt; }
.cover .kind { font-size: 16pt; color: #595959; margin: 0 0 24pt; }
.cover .title { font-size: 14pt; margin: 0 0 12pt; }
.cover .date { font-size: 11pt; color: #595959; }
`;

function coverHtml(b: DocBranding): string {
  const c = b.cover!;
  let img = "";
  if (b.logo) {
    // Same box as the Word cover: up to 3.5" wide and 1.75" tall.
    const [w, h] = fitInside(b.logo.width, b.logo.height, 3.5, 1.75);
    img = `<img src="${dataUrl(b.logo)}" alt="" style="width:${w.toFixed(3)}in;height:${h.toFixed(3)}in">`;
  }
  const line = (cls: string, text: string) => (text.trim() ? `<p class="${cls}">${escapeHtml(text)}</p>` : "");
  return `<section class="cover">${img}${line("show", c.show)}${line("kind", c.kind)}${line("title", c.title)}${line("date", c.date)}</section>`;
}

/** A complete HTML page for one document. Nothing in it loads from anywhere. */
export function blocksToHtml(blocks: Block[], title: string, branding?: DocBranding): string {
  const style = STYLE + (branding ? pageStyle(branding) + (branding.cover ? COVER_STYLE : "") : "");
  const cover = branding?.cover ? coverHtml(branding) : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<title>${escapeHtml(title)}</title><style>${style}</style></head>` +
    `<body>${cover}${blocks.map(block).join("\n")}</body></html>`
  );
}
