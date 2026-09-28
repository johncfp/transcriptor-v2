// What gets exported for an episode, and what the files are called. Pure, so
// the same names and documents are used by the exporter and shown in the UI.

import type { CleanTurn } from "./cleanup";
import {
  buildReference,
  buildShowNotes,
  type Block,
  type EpisodeDetails,
  type SectionId,
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

/** The transcript as a document: one paragraph per turn, "Name [00:00]: text". */
export function buildTranscriptDoc(turns: CleanTurn[], opts: { title: string; subtitle?: string; timestamps: boolean }): Block[] {
  const blocks: Block[] = [{ type: "heading", level: 1, text: opts.title }];
  if (opts.subtitle) blocks.push({ type: "paragraph", runs: [{ text: opts.subtitle, italic: true }] });
  for (const turn of turns) {
    blocks.push({
      type: "paragraph",
      runs: [
        { text: turn.speaker, bold: true },
        { text: opts.timestamps ? ` [${formatTimestamp(turn.start)}]: ` : ": " },
        { text: turn.words.map((w) => w.text).join(" ") },
      ],
    });
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
  transcriptTimestamps: boolean;
}

/** The transcript always; show notes and reference file once they're written. */
export function episodeDocuments(input: EpisodeDocsInput): { label: string; documents: ExportDocument[] } {
  const label = episodeLabel(input.details, input.writing, input.fileName);
  const documents: ExportDocument[] = [
    {
      kind: "Transcript",
      blocks: buildTranscriptDoc(input.turns, {
        title: label,
        subtitle: [input.show.name, "Transcript"].filter(Boolean).join(" · "),
        timestamps: input.transcriptTimestamps,
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
