// What gets exported for an episode, and what the files are called. Pure, so
// the same names and documents are used by the exporter and shown in the UI.

import type { CleanTurn, CleanWord } from "./cleanup";
import { CONFIDENCE_COLORS, confidenceLevel, type ConfidenceLevel, type ConfidenceThresholds } from "./confidence";
import type { SpeakerFormat } from "./settings";
import {
  buildReference,
  buildShowNotes,
  type Block,
  type EpisodeDetails,
  type SectionId,
  type Run,
  type ShowProfileLike,
  type WritingResult,
} from "./showNotes";
import { formatTimestamp } from "./transcript";

export type ExportFormat = "docx" | "txt";
export type DocKind = "Transcript" | "Show Notes" | "Reference";

export interface ExportDocument {
  kind: DocKind;
  blocks: Block[];
}

export interface TranscriptDocOptions {
  title: string;
  subtitle?: string;
  timestamps: boolean;
  format: SpeakerFormat;
  /** Color low/medium-confidence words with these bands; null = no color. */
  confidence: ConfidenceThresholds | null;
}

/** A turn's words as runs, with neighbouring words of the same confidence band sharing one run. */
function wordRuns(words: CleanWord[], confidence: ConfidenceThresholds | null): Run[] {
  const runs: Run[] = [];
  let level: ConfidenceLevel | null = null;
  for (const w of words) {
    const next = confidence ? confidenceLevel(w.confidence, confidence) : null;
    const last = runs.at(-1);
    if (last && next === level) last.text += ` ${w.text}`;
    else {
      if (last) last.text += " "; // the space between runs goes with the earlier run
      runs.push(next ? { text: w.text, color: CONFIDENCE_COLORS[next] } : { text: w.text });
    }
    level = next;
  }
  return runs;
}

/** The transcript as a document, laid out in one of Transcriptor 1's speaker formats. */
export function buildTranscriptDoc(turns: CleanTurn[], opts: TranscriptDocOptions): Block[] {
  const blocks: Block[] = [{ type: "heading", level: 1, text: opts.title }];
  if (opts.subtitle) blocks.push({ type: "paragraph", runs: [{ text: opts.subtitle, italic: true }] });
  for (const turn of turns) {
    const time = formatTimestamp(turn.start);
    const text = wordRuns(turn.words, opts.confidence);
    const prefix: Run[] = opts.timestamps ? [{ text: `[${time}] ` }] : [];
    switch (opts.format) {
      case "stacked":
        blocks.push({
          type: "paragraph",
          runs: [{ text: turn.speaker, bold: true }, ...(opts.timestamps ? [{ text: `  ${time}`, italic: true }] : [])],
        });
        blocks.push({ type: "paragraph", runs: text });
        break;
      case "inline":
        blocks.push({ type: "paragraph", runs: [...prefix, { text: turn.speaker, bold: true }, { text: ": " }, ...text] });
        break;
      case "dash":
        blocks.push({ type: "paragraph", runs: [...prefix, { text: turn.speaker, bold: true }, { text: " — " }, ...text] });
        break;
      case "caps":
        blocks.push({ type: "paragraph", runs: [...prefix, { text: turn.speaker.toUpperCase(), bold: true }, { text: ": " }, ...text] });
        break;
      case "timeAfter":
        blocks.push({
          type: "paragraph",
          runs: [{ text: turn.speaker, bold: true }, { text: opts.timestamps ? ` [${time}]: ` : ": " }, ...text],
        });
        break;
    }
  }
  return blocks;
}

/** "Episode 386 - AI, Productivity and Love with Pete M." or the audio file's name. */
export function episodeLabel(details: EpisodeDetails, writing: WritingResult | null, fileName: string): string {
  const title = details.title.trim() || writing?.notes.titleSuggestion || "";
  const n = details.episodeNumber.trim();
  if (n) return `Episode ${n}${title ? ` - ${title}` : ""}`;
  return title || fileName.replace(/\.[^.]+$/, "");
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * A name that's safe as a file or folder on Windows and macOS: no reserved
 * characters or names, no trailing dots or spaces, not too long.
 */
export function safeFileName(name: string, max = 100): string {
  let s = name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max).trim();
  s = s.replace(/[. ]+$/, "");
  if (!s) s = "Episode";
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

export function fileNameFor(base: string, kind: DocKind, format: ExportFormat): string {
  return `${base} - ${kind}.${format}`;
}

export interface EpisodeDocsInput {
  turns: CleanTurn[];
  details: EpisodeDetails;
  writing: WritingResult | null;
  fileName: string;
  show: ShowProfileLike;
  sections: SectionId[];
  transcript: Omit<TranscriptDocOptions, "title" | "subtitle">;
}

/** The transcript always; show notes and reference file once they're written. */
export function episodeDocuments(input: EpisodeDocsInput): { label: string; documents: ExportDocument[] } {
  const label = episodeLabel(input.details, input.writing, input.fileName);
  const documents: ExportDocument[] = [
    {
      kind: "Transcript",
      blocks: buildTranscriptDoc(input.turns, {
        ...input.transcript,
        title: label,
        subtitle: [input.show.name, "Transcript"].filter(Boolean).join(" · "),
      }),
    },
  ];
  if (input.writing) {
    const result = { ...input.writing, details: input.details };
    documents.push(
      { kind: "Show Notes", blocks: buildShowNotes(result, input.show, input.sections) },
      { kind: "Reference", blocks: buildReference(result, input.show) },
    );
  }
  return { label, documents };
}
