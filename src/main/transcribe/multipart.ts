import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { basename } from "node:path";

export interface MultipartFile {
  field: string;
  path: string;
  contentType?: string;
}

export interface PostMultipartOptions {
  url: string;
  headers: Record<string, string>;
  fields: [string, string][];
  file: MultipartFile;
  /** Fraction of the request body sent so far, 0–1. */
  onUploadProgress?: (fraction: number) => void;
  /** The whole body has been sent; the server is now working. */
  onUploaded?: () => void;
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  text: string;
}

/** Thrown for connection problems, as opposed to an HTTP error status. */
export class NetworkError extends Error {}
export class AbortedError extends Error {}

/**
 * POST multipart/form-data, streaming the file from disk. Written by hand
 * (rather than fetch + FormData) because fetch can't report upload progress,
 * and a podcast upload takes long enough that people need to see it moving.
 */
export function postMultipart(opts: PostMultipartOptions): Promise<HttpResult> {
  const boundary = `----transcriptor${randomBytes(12).toString("hex")}`;
  const fieldParts = opts.fields
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join("");
  const fileName = basename(opts.file.path).replace(/"/g, "");
  const head = Buffer.from(
    `${fieldParts}--${boundary}\r\nContent-Disposition: form-data; name="${opts.file.field}"; filename="${fileName}"\r\n` +
      `Content-Type: ${opts.file.contentType ?? "application/octet-stream"}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const fileSize = statSync(opts.file.path).size;
  const total = head.length + fileSize + tail.length;

  const url = new URL(opts.url);
  const client = url.protocol === "http:" ? http : https;

  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AbortedError("aborted"));

    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = client.request(url, {
      method: "POST",
      headers: {
        ...opts.headers,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(total),
      },
    });

    const stream = createReadStream(opts.file.path);
    const onAbort = () => {
      stream.destroy();
      req.destroy();
      fail(new AbortedError("aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => fail(new NetworkError(err.message)));
    });
    req.on("error", (err) => {
      if (opts.signal?.aborted) return fail(new AbortedError("aborted"));
      fail(new NetworkError(err.message));
    });

    let sent = 0;
    const report = (n: number) => {
      sent += n;
      opts.onUploadProgress?.(sent / total);
    };

    req.write(head);
    report(head.length);
    stream.on("data", (chunk) => {
      const buf = chunk as Buffer;
      // Respect backpressure so progress tracks what's actually been sent.
      if (!req.write(buf)) {
        stream.pause();
        req.once("drain", () => stream.resume());
      }
      report(buf.length);
    });
    stream.on("error", (err) => {
      req.destroy();
      fail(new Error(`Couldn't read the audio file: ${err.message}`));
    });
    stream.on("end", () => {
      req.end(tail, () => {
        report(tail.length);
        opts.onUploaded?.();
      });
    });
  });
}
