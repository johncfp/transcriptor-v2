import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { buildTranscriptDoc, episodeLabel, safeFileName } from "../src/shared/exportDocs";
import { DEFAULT_CONFIDENCE_THRESHOLDS } from "../src/shared/confidence";
import type { SpeakerFormat } from "../src/shared/settings";
import { EMPTY_DETAILS, toPlainText, type Block } from "../src/shared/showNotes";
import { buildDocx } from "../src/main/docx";
import { writeExport } from "../src/main/exporter";

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

test("export writes each document in each format into the episode's folder", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  const docs = [
    { kind: "Transcript" as const, blocks: SAMPLE },
    { kind: "Show Notes" as const, blocks: SAMPLE },
  ];
  const result = writeExport(root, 'Episode 386 - Love: "AI"', docs, ["docx", "txt"]);
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
  writeExport(root, 'Episode 386 - Love: "AI"', docs, ["docx", "txt"]);
  assert.equal(readdirSync(result.folder).length, 4);
});

test("export errors are readable", () => {
  const root = mkdtempSync(join(tmpdir(), "t2-export-"));
  assert.throws(() => writeExport(root, "x", [], []), /Choose at least one format/);
  // A file where the folder should be.
  writeFileSync(join(root, "Episode 1"), "");
  assert.throws(() => writeExport(root, "Episode 1", [{ kind: "Transcript", blocks: [] }], ["txt"]), /Couldn't|export/i);
});
