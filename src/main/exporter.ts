import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLIPS_FOLDER, fileNameFor, isClipFile, safeFileName, type ExportDocument, type ExportFormat } from "../shared/exportDocs";
import { toPlainText } from "../shared/showNotes";
import { buildDocx } from "./docx";
import { coverLines, docBranding, type CoverPage, type ExportBranding } from "./brandingDoc";
import { blocksToHtml } from "./pdfHtml";

/** Turns a print-ready HTML page into PDF bytes; `folder` is where it may put a temporary file. */
export type PdfRenderer = (html: string, folder: string) => Promise<Uint8Array>;

export interface ExportResult {
  folder: string;
  files: string[];
}

/**
 * Write an episode's documents into `<root>/<label>/`, one file per document
 * and format, replacing earlier exports of the same episode.
 */
export interface ExportOptions {
  renderPdf?: PdfRenderer;
  branding?: ExportBranding;
  /**
   * Kept clips' audio and videos, written to <folder>/Clips/ in place of the
   * episode's earlier clip files. Undefined leaves that folder alone.
   */
  clips?: { name: string; data: Uint8Array }[];
  /**
   * Which of the episode's earlier clip files `clips` replaces: the kept clips'
   * own export replaces audio and video; the episode's export, which makes no
   * videos, only the audio, so videos made from the Clips tab stay.
   */
  replaceClips?: ("wav" | "mp4")[];
}

export async function writeExport(
  root: string,
  label: string,
  documents: ExportDocument[],
  formats: ExportFormat[],
  { renderPdf, branding, clips, replaceClips = ["wav", "mp4"] }: ExportOptions = {},
): Promise<ExportResult> {
  if (!formats.length && !clips?.length) throw new Error("Choose at least one format to export.");
  if (formats.includes("pdf") && !renderPdf) throw new Error("PDF export isn't available here.");
  const base = safeFileName(label);
  const folder = join(root, base);
  const files: string[] = [];
  try {
    mkdirSync(folder, { recursive: true });
    for (const doc of documents) {
      const brand = branding && docBranding(branding, doc.kind, label);
      for (const format of formats) {
        const path = join(folder, fileNameFor(base, doc.kind, format));
        // Plain text gets a byte-order mark so older editors read curly quotes and dashes as UTF-8.
        const data =
          format === "docx"
            ? buildDocx(doc.blocks, brand)
            : format === "pdf"
              ? await renderPdf!(blocksToHtml(doc.blocks, `${base} - ${doc.kind}`, brand), folder)
              : `﻿${plainCover(brand?.cover)}${toPlainText(doc.blocks)}\n`;
        writeFileSync(path, data);
        files.push(path);
      }
    }
    if (clips) {
      const clipsFolder = join(folder, CLIPS_FOLDER);
      mkdirSync(clipsFolder, { recursive: true });
      // Clips un-kept since the last export shouldn't linger; only this episode's clip files are touched.
      for (const name of readdirSync(clipsFolder)) {
        const kind = name.split(".").pop()!.toLowerCase() as "wav" | "mp4";
        if (isClipFile(base, name) && replaceClips.includes(kind)) rmSync(join(clipsFolder, name), { force: true });
      }
      for (const clip of clips) {
        const path = join(clipsFolder, clip.name);
        writeFileSync(path, clip.data);
        files.push(path);
      }
    }
  } catch (err) {
    throw new Error(explainWriteError(err, folder));
  }
  return { folder, files };
}

/** Plain text has no pages, so its cover is a few lines above a rule; no logo, header or footer. */
function plainCover(cover: CoverPage | undefined): string {
  return cover ? `${coverLines(cover).join("\n")}\n\n${"—".repeat(40)}\n\n` : "";
}

function explainWriteError(err: unknown, folder: string): string {
  const e = err as NodeJS.ErrnoException;
  const file = e.path ? `“${e.path.split(/[\\/]/).pop()}”` : "a file";
  switch (e.code) {
    case "EBUSY":
    case "EPERM":
      return `Couldn't save ${file}. If it's open in Word, a PDF viewer or another program, close it and export again.`;
    case "EACCES":
    case "EROFS":
      return `Transcriptor 2 isn't allowed to save in ${folder}. Choose another folder in Settings.`;
    case "ENOSPC":
      return "The disk is full.";
    case "ENOENT":
      return `The export folder ${folder} couldn't be created. Check the folder in Settings.`;
    default:
      return `Couldn't export: ${e.message ?? String(err)}`;
  }
}
