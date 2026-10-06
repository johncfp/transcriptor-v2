import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeImage } from "electron";
import { BACKGROUND_FILE } from "../shared/video";

/**
 * The video clips' background image. Like the logo (src/main/logo.ts), a
 * picked image is copied into userData/branding under a new name each time, so
 * a Settings draft that's discarded never changes the saved one, and unused
 * copies are removed at startup. Stored as JPEG: backgrounds are usually photos.
 */

/** Enough to cover a 1920-pixel side with room to crop. */
const MAX_SIDE = 2400;

const dir = (userData: string) => join(userData, "branding");

/** Copy an image into the app as the video background; returns its file name. */
export function importBackground(userData: string, source: string): string {
  let image = nativeImage.createFromPath(source);
  if (image.isEmpty()) throw new Error("That file isn't an image Transcriptor 2 can read. Choose a PNG or JPEG.");
  const { width, height } = image.getSize();
  if (Math.max(width, height) > MAX_SIDE) {
    image = width >= height ? image.resize({ width: MAX_SIDE, quality: "best" }) : image.resize({ height: MAX_SIDE, quality: "best" });
  }
  mkdirSync(dir(userData), { recursive: true });
  const name = `background-${Date.now()}.jpg`;
  writeFileSync(join(dir(userData), name), image.toJPEG(90));
  return name;
}

export function backgroundPath(userData: string, name: string): string | null {
  if (!BACKGROUND_FILE.test(name)) return null;
  const file = join(dir(userData), name);
  return existsSync(file) ? file : null;
}

/** The background for the Settings preview, as a data: URL no wider than `width`. */
export function backgroundPreview(userData: string, name: string, width = 720): string | null {
  const file = backgroundPath(userData, name);
  if (!file) return null;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  return (image.getSize().width > width ? image.resize({ width, quality: "best" }) : image).toDataURL();
}

/** Remove background copies other than the one in use. */
export function pruneBackgrounds(userData: string, keep: string): void {
  try {
    for (const f of readdirSync(dir(userData))) {
      if (BACKGROUND_FILE.test(f) && f !== keep) rmSync(join(dir(userData), f), { force: true });
    }
  } catch {
    // No branding folder yet, or a file in use: try again next start.
  }
}
