import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileNameFor, safeFileName, type ExportDocument, type ExportFormat } from "../shared/exportDocs";
import { toPlainText } from "../shared/showNotes";
import { buildDocx } from "./docx";
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
export async function writeExport(
  root: string,
  label: string,
  documents: ExportDocument[],
  formats: ExportFormat[],
  renderPdf?: PdfRenderer,
): Promise<ExportResult> {
  if (!formats.length) throw new Error("Choose at least one format to export.");
  if (formats.includes("pdf") && !renderPdf) throw new Error("PDF export isn't available here.");
  const base = safeFileName(label);
  const folder = join(root, base);
  const files: string[] = [];
  try {
    mkdirSync(folder, { recursive: true });
    for (const doc of documents) {
      for (const format of formats) {
        const path = join(folder, fileNameFor(base, doc.kind, format));
        // Plain text gets a byte-order mark so older editors read curly quotes and dashes as UTF-8.
        const data =
          format === "docx"
            ? buildDocx(doc.blocks)
            : format === "pdf"
              ? await renderPdf!(blocksToHtml(doc.blocks, `${base} - ${doc.kind}`), folder)
              : `﻿${toPlainText(doc.blocks)}\n`;
        writeFileSync(path, data);
        files.push(path);
      }
    }
  } catch (err) {
    throw new Error(explainWriteError(err, folder));
  }
  return { folder, files };
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
