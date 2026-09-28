import { createWriteStream, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { GoogleTokens } from "./googleAuth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
}

export interface DriveClientDeps {
  getTokens: () => GoogleTokens | null;
  saveTokens: (t: GoogleTokens) => void;
  refresh: (t: GoogleTokens) => Promise<GoogleTokens>;
  /** Overrides https://www.googleapis.com (tests). */
  baseUrl?: string;
}

/**
 * The two Drive API v3 calls the watcher needs: list a folder, download a
 * file. Access tokens are refreshed when they're about to expire, and once
 * more if Google says one has been revoked early.
 */
export class DriveClient {
  constructor(private readonly deps: DriveClientDeps) {}

  private get base() {
    return this.deps.baseUrl ?? "https://www.googleapis.com";
  }

  private async token(force = false): Promise<string> {
    let t = this.deps.getTokens();
    if (!t) throw new Error("Not signed in to Google.");
    if (force || t.expiresAt - Date.now() < 60_000) {
      t = await this.deps.refresh(t);
      this.deps.saveTokens(t);
    }
    return t.accessToken;
  }

  private async get(url: string): Promise<Response> {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (res.status === 401) res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token(true)}` } });
    if (!res.ok) throw new Error(`Google Drive returned an error (${res.status}).`);
    return res;
  }

  /** Files directly inside a folder, oldest first (not recursive; trash excluded). */
  async listFolder(folderId: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken = "";
    do {
      const q = new URLSearchParams({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, createdTime)",
        orderBy: "createdTime",
        pageSize: "200",
        // Shared drives, which a team is likely to use.
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const data = (await (await this.get(`${this.base}/drive/v3/files?${q}`)).json()) as {
        files?: DriveFile[];
        nextPageToken?: string;
      };
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken ?? "";
    } while (pageToken);
    return files;
  }

  /** Stream a file to `path`, via a temp file so a half-finished download never looks complete. */
  async download(fileId: string, path: string): Promise<void> {
    const res = await this.get(`${this.base}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
    if (!res.body) throw new Error("Google Drive sent an empty download.");
    const tmp = `${path}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(tmp));
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/** A Drive folder id from a pasted link or a bare id; null if it isn't one. */
export function parseFolderId(input: string): string | null {
  const s = input.trim();
  const fromUrl = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1] ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1];
  if (fromUrl) return fromUrl;
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}
