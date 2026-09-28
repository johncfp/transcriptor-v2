import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { MEDIA_SCHEME } from "../shared/jobs";
import { AUDIO_MIME, parseRange } from "./range";

/**
 * Serves an episode's audio to the review screen at `t2-media://audio/<jobId>`.
 * The sandboxed renderer can't open files itself, and the id is looked up
 * in the queue, so only files that were added as episodes can be read.
 * Range requests are handled so the player can seek.
 */

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

export function handleMedia(audioPathFor: (jobId: string) => string | null): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    const path = url.hostname === "audio" ? audioPathFor(decodeURIComponent(url.pathname.slice(1))) : null;
    let size: number;
    try {
      if (!path) throw new Error("unknown episode");
      size = statSync(path).size;
    } catch {
      return new Response(null, { status: 404 });
    }

    const type = AUDIO_MIME[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
    const range = parseRange(request.headers.get("range"), size);
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  });
}
