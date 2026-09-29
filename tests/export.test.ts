import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildTranscriptDoc, episodeLabel, safeFileName } from "../src/shared/exportDocs";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "../src/shared/confidence";
import { DEFAULT_SETTINGS, mergeSettings, type SpeakerFormat } from "../src/shared/settings";
import { EMPTY_DETAILS, toPlainText, type Block } from "../src/shared/showNotes";
import { buildDocx } from "../src/main/docx";
import { writeExport } from "../src/main/exporter";
import { docBranding, type ExportBranding } from "../src/main/brandingDoc";

test("file names are safe on Windows and macOS", () => {
  assert.equal(safeFileName('Episode 386 - AI: "Love" & Work?'), "Episode 386 - AI Love & Work");
  assert.equal(safeFileName("  ends with dots... "), "ends with dots");
  assert.equal(safeFileName("CON"), "CON_");
  assert.equal(safeFileName("///"), "Episode");
  assert.equal(safeFileName("x".repeat(300)).length, 100);
});

test("episode label: number and title, else the audio file's name", () => {
  assert.equal(episodeLabel({ ...EMPTY_DETAILS, episodeNumber: "386", title: "Pete" }, null, "a.m4a"), "Episode 386 - Pete");
  assert.equal(episodeLabel({ ...EMPTY_DETAILS, episodeNumber: "386" }, null, "a.m4a"), "Episode 386");
  assert.equal(episodeLabel(EMPTY_DETAILS, null, "BrianxDelaney_Export.edited.m4a"), "BrianxDelaney_Export.edited");
});

test("transcript document: Transcriptor 1's speaker formats, timestamps optional", () => {
  const turns = [
    { speaker: "Pete M.", start: 75, words: [{ index: 1, text: "Thanks.", start: 75, end: 76 }] },
  ];
  const text = (format: SpeakerFormat, timestamps = true) =>
    toPlainText(buildTranscriptDoc(turns, { title: "T", timestamps, format, confidence: null }).slice(1));
  assert.equal(text("stacked"), "Pete M.  01:15\n\nThanks.");
  assert.equal(text("inline"), "[01:15] Pete M.: Thanks.");
  assert.equal(text("dash"), "[01:15] Pete M. — Thanks.");
  assert.equal(text("caps"), "[01:15] PETE M.: Thanks.");
  assert.equal(text("timeAfter"), "Pete M. [01:15]: Thanks.");
  assert.equal(text("inline", false), "Pete M.: Thanks.");
  assert.equal(text("stacked", false), "Pete M.\n\nThanks.");
});

test("transcript document: low and medium confidence words get Transcriptor 1's colors", () => {
  const words = [
    { index: 0, text: "I", start: 0, end: 0, confidence: 0.99 },
    { index: 1, text: "met", start: 0, end: 0, confidence: 0.99 },
    { index: 2, text: "Delaney", start: 0, end: 0, confidence: 0.3 },
    { index: 3, text: "Howell", start: 0, end: 0, confidence: 0.8 },
    { index: 4, text: "today.", start: 0, end: 0, confidence: 0.99 },
  ];
  const doc = buildTranscriptDoc([{ speaker: "Brian", start: 0, words }], {
    title: "T",
    timestamps: false,
    format: "inline",
    confidence: DEFAULT_CONFIDENCE_THRESHOLDS,
  });
  const runs = (doc[1] as { runs: { text: string; color?: string }[] }).runs.slice(2);
  assert.deepEqual(runs, [
    { text: "I met " },
    { text: "Delaney ", color: "DC2626" },
    { text: "Howell ", color: "EA580C" },
    { text: "today." },
  ]);
  const plain = buildTranscriptDoc([{ speaker: "Brian", start: 0, words }], {
    title: "T",
    timestamps: false,
    format: "inline",
    confidence: null,
  });
  assert.equal((plain[1] as { runs: unknown[] }).runs.length, 3, "no coloring: one run of text");
  assert.match(strFromU8(unzipSync(buildDocx(doc))["word/document.xml"]!), /<w:color w:val="DC2626"\/><\/w:rPr><w:t xml:space="preserve">Delaney /);
});

const SAMPLE: Block[] = [
  { type: "heading", level: 1, text: "This Is A Test Show" },
  { type: "paragraph", runs: [{ text: "Guest: ", bold: true }, { text: "Pete M. & <friends>" }] },
  { type: "list", ordered: true, items: [[{ text: "one" }], [{ text: "two" }]] },
  { type: "list", ordered: true, items: [[{ text: "again from one" }]] },
  { type: "list", ordered: false, items: [[{ text: "Website: ", bold: true }, { text: "https://pete.example/?a=1&b=2" }]] },
  { type: "table", header: ["Time", "Segment"], rows: [["00:00", "Welcome"]] },
  { type: "quote", text: "Nobody has ever fallen in love with an optimized calendar.", attribution: "Pete M." },
  { type: "rule" },
];

test("DOCX: the parts Word needs, heading styles, restarting lists, working links", () => {
  const parts = unzipSync(buildDocx(SAMPLE));
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/_rels/document.xml.rels"]) {
    assert.ok(parts[name], `has ${name}`);
  }
  const doc = strFromU8(parts["word/document.xml"]!);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/>.*This Is A Test Show/);
  assert.match(doc, /Pete M\. &amp; &lt;friends&gt;/, "text is escaped");
  // Each numbered list has its own numbering instance (so both start at 1); bullets use numId 1.
  assert.match(doc, /<w:numId w:val="2"\/>.*one/);
  assert.match(doc, /<w:numId w:val="3"\/>.*again from one/);
  const numbering = strFromU8(parts["word/numbering.xml"]!);
  assert.match(numbering, /<w:num w:numId="3"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/>/);
  // The URL is a real hyperlink with an escaped target.
  assert.match(doc, /<w:hyperlink r:id="rIdLink0">/);
  const rels = strFromU8(parts["word/_rels/document.xml.rels"]!);
  assert.match(rels, /Id="rIdLink0"[^>]*Target="https:\/\/pete\.example\/\?a=1&amp;b=2" TargetMode="External"/);
  assert.match(doc, /<w:tbl>.*00:00.*<\/w:tbl><w:p>/, "a paragraph follows the table");
});

test("export writes each document in each format into the episode's folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  const docs = [
    { kind: "Transcript" as const, blocks: SAMPLE },
    { kind: "Show Notes" as const, blocks: SAMPLE },
  ];
  const result = await writeExport(root, 'Episode 386 - Love: "AI"', docs, ["docx", "txt"]);
  assert.equal(result.folder, join(root, "Episode 386 - Love AI"));
  assert.deepEqual(readdirSync(result.folder).sort(), [
    "Episode 386 - Love AI - Show Notes.docx",
    "Episode 386 - Love AI - Show Notes.txt",
    "Episode 386 - Love AI - Transcript.docx",
    "Episode 386 - Love AI - Transcript.txt",
  ]);
  const txt = readFileSync(join(result.folder, "Episode 386 - Love AI - Transcript.txt"), "utf8");
  assert.ok(txt.startsWith("﻿THIS IS A TEST SHOW"), "UTF-8 with a byte-order mark");
  assert.match(txt, /“Nobody has ever fallen in love with an optimized calendar\.”/);

  // Exporting again replaces the files rather than adding copies.
  await writeExport(root, 'Episode 386 - Love: "AI"', docs, ["docx", "txt"]);
  assert.equal(readdirSync(result.folder).length, 4);
});

test("export errors are readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  await assert.rejects(writeExport(root, "x", [], []), /Choose at least one format/);
  await assert.rejects(writeExport(root, "x", [], ["pdf"]), /PDF export isn't available/);
  // A file where the folder should be.
  writeFileSync(join(root, "Episode 1"), "");
  await assert.rejects(writeExport(root, "Episode 1", [{ kind: "Transcript", blocks: [] }], ["txt"]), /Couldn't|export/i);
});

test("PDF export: each document is rendered from its own HTML page", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  const pages: string[] = [];
  const result = await writeExport(root, "Episode 386", [{ kind: "Show Notes", blocks: SAMPLE }], ["pdf"], {
    renderPdf: async (html, folder) => {
      assert.equal(folder, join(root, "Episode 386"), "temporary files go in the episode's folder");
      pages.push(html);
      return new TextEncoder().encode("%PDF-1.7 fake");
    },
  });
  assert.deepEqual(readdirSync(result.folder), ["Episode 386 - Show Notes.pdf"]);
  assert.equal(readFileSync(result.files[0]!, "utf8"), "%PDF-1.7 fake");
  assert.match(pages[0]!, /<title>Episode 386 - Show Notes<\/title>/);
});

test("PDF HTML: escaped text, links, lists, tables and quotes; nothing loads from outside", async () => {
  const { blocksToHtml } = await import("../src/main/pdfHtml");
  const html = blocksToHtml(
    [
      { type: "heading", level: 1, text: "Love & <AI>" },
      { type: "paragraph", runs: [{ text: "Site: ", bold: true }, { text: "https://pete.example/?a=1&b=2" }] },
      { type: "paragraph", runs: [{ text: "unsure", color: "DC2626" }] },
      { type: "list", ordered: true, items: [[{ text: "One" }], [{ text: "Two" }]] },
      { type: "table", header: ["Time", "Topic"], rows: [["00:00", "<script>"]] },
      { type: "quote", text: "Hi", attribution: "Pete" },
    ],
    "T",
  );
  assert.match(html, /<h1>Love &amp; &lt;AI&gt;<\/h1>/);
  assert.match(html, /<b>Site: <\/b><a href="https:\/\/pete\.example\/\?a=1&amp;b=2">/);
  assert.ok(!html.includes("DC2626"), "confidence colors are Word-only");
  assert.match(html, /<ol><li>One<\/li><li>Two<\/li><\/ol>/);
  assert.match(html, /<td>&lt;script&gt;<\/td>/);
  assert.match(html, /“Hi”.*— Pete/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

const LOGO = { png: new Uint8Array([137, 80, 78, 71]), width: 400, height: 100, small: { png: new Uint8Array([1]), width: 480, height: 120 } };
const BRANDING: ExportBranding = {
  coverPage: true,
  show: "This Is A Test Show",
  date: "September 29, 2026",
  logo: LOGO,
  logoInHeader: true,
  headerText: "Confidential",
  footerText: "© 2026 Test & Co",
  pageNumbers: true,
};

test("Word branding: cover page, logo, header and footer parts", () => {
  const parts = unzipSync(buildDocx(SAMPLE, docBranding(BRANDING, "Show Notes", "Episode 386")));
  const doc = strFromU8(parts["word/document.xml"]!);
  const types = strFromU8(parts["[Content_Types].xml"]!);
  const rels = strFromU8(parts["word/_rels/document.xml.rels"]!);
  // Cover first: logo (4:1, fitted to 3.5" wide), show, document, episode, date, then a page break.
  assert.match(doc, /<w:body><w:p>.*r:embed="rIdLogo".*This Is A Test Show.*Show Notes.*Episode 386.*September 29, 2026.*<w:br w:type="page"\/>/);
  assert.match(doc, /<wp:extent cx="3200400" cy="800100"\/>/);
  // sectPr: references first, then page setup, then titlePg so the cover has no header or footer.
  assert.match(doc, /<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"\/><w:footerReference w:type="default" r:id="rIdFooter"\/><w:pgSz[^]*<w:titlePg\/><\/w:sectPr>/);
  assert.match(rels, /Id="rIdLogo"[^>]*Target="media\/logo\.png"/);
  assert.deepEqual([...parts["word/media/logo.png"]!], [...LOGO.png]);
  assert.match(types, /Extension="png"/);
  assert.match(types, /PartName="\/word\/header1\.xml"/);
  assert.match(types, /PartName="\/word\/footer1\.xml"/);
  const header = strFromU8(parts["word/header1.xml"]!);
  assert.match(header, /r:embed="rIdHeaderLogo".*<w:tab\/>.*Confidential/);
  assert.match(strFromU8(parts["word/_rels/header1.xml.rels"]!), /Id="rIdHeaderLogo"[^>]*Target="media\/logo\.png"/);
  const footer = strFromU8(parts["word/footer1.xml"]!);
  assert.match(footer, /© 2026 Test &amp; Co.*<w:tab\/>.*Page .* PAGE .* of .* NUMPAGES /);
});

test("Word branding: nothing set means no extra parts, as before", () => {
  const plain = docBranding({ ...BRANDING, coverPage: false, logo: undefined, headerText: "", footerText: "", pageNumbers: false }, "Transcript", "x");
  for (const parts of [unzipSync(buildDocx(SAMPLE)), unzipSync(buildDocx(SAMPLE, plain))]) {
    assert.deepEqual(Object.keys(parts).sort(), [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/document.xml",
      "word/numbering.xml",
      "word/styles.xml",
    ]);
    assert.ok(!strFromU8(parts["[Content_Types].xml"]!).includes("header1"));
  }
  // A header without the logo has no header relationships.
  const textOnly = unzipSync(buildDocx(SAMPLE, docBranding({ ...BRANDING, coverPage: false, logoInHeader: false }, "Transcript", "x")));
  assert.ok(textOnly["word/header1.xml"] && !textOnly["word/_rels/header1.xml.rels"] && !textOnly["word/media/logo.png"]);
  assert.ok(!strFromU8(textOnly["word/document.xml"]!).includes("titlePg"));
});

test("PDF branding: cover page, margin boxes, and none on the cover", async () => {
  const { blocksToHtml } = await import("../src/main/pdfHtml");
  const html = blocksToHtml(SAMPLE, "T", docBranding({ ...BRANDING, headerText: 'Say "hi" </style><script>' }, "Show Notes", "Episode 386"));
  assert.match(html, /<body><section class="cover"><img src="data:image\/png;base64,iVBORw==" alt="" style="width:3\.500in;height:0\.875in">/);
  assert.match(html, /<p class="show">This Is A Test Show<\/p><p class="kind">Show Notes<\/p><p class="title">Episode 386<\/p><p class="date">September 29, 2026<\/p><\/section>/);
  assert.match(html, /@top-left \{ content: image-set\(url\("data:image\/png;base64,AQ=="\) 3x\)/);
  assert.match(html, /@top-right \{ content: "Say \\"hi\\" \\3C \/style>\\3C script>"/);
  assert.equal(html.split("</style>").length, 2, "header text can't close the style element");
  assert.match(html, /@bottom-left \{ content: "© 2026 Test & Co"/);
  assert.match(html, /@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\)/);
  assert.match(html, /@page :first \{ @top-left \{ content: none; \}/);
  // Without a cover, every page gets the header and footer.
  const noCover = blocksToHtml(SAMPLE, "T", docBranding({ ...BRANDING, coverPage: false }, "Show Notes", "x"));
  assert.ok(!noCover.includes(":first") && !noCover.includes('class="cover"'));
});

test("plain text gets the cover as lines at the top", async () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  const result = await writeExport(root, "Episode 386", [{ kind: "Show Notes", blocks: SAMPLE }], ["txt"], { branding: BRANDING });
  const txt = readFileSync(result.files[0]!, "utf8");
  assert.ok(txt.startsWith("\ufeffThis Is A Test Show\nShow Notes\nEpisode 386\nSeptember 29, 2026\n\n———"));
  assert.ok(!txt.includes("Confidential"), "no header or footer in plain text");
});

test("settings: the logo can only name an imported logo file", () => {
  const merged = (logo: string) => mergeSettings(DEFAULT_SETTINGS, { output: { branding: { logo } } }).output.branding.logo;
  assert.equal(merged("logo-1759150000000.png"), "logo-1759150000000.png");
  assert.equal(merged("../../keys.json"), "");
  assert.equal(merged("C:\\logo.png"), "");
  assert.equal(merged(""), "");
});
