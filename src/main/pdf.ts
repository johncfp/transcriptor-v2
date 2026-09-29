import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow } from "electron";

/**
 * Print an HTML page to PDF with Chromium, in a hidden window that runs no
 * scripts and can't navigate. The page goes through a temporary file next
 * to the export (a data: URL has a size limit a long transcript can hit),
 * which is removed afterwards.
 */
export async function printPdf(html: string, folder: string): Promise<Buffer> {
  const file = join(folder, `.t2-print-${process.pid}-${Date.now()}.html`);
  writeFileSync(file, html);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  try {
    await win.loadFile(file);
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
    rmSync(file, { force: true });
  }
}
