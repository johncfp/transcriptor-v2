import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeImage } from "electron";
import { LOGO_FILE } from "../shared/settings";
import type { Logo } from "./brandingDoc";

/**
 * The export logo. A picked image is copied into userData/branding as a PNG
 * under a new name each time, so a Settings draft that's discarded never
 * changes the logo that's saved. Unused copies are removed at startup.
 */

/** Big enough for a cover page at print resolution. */
const MAX_SIDE = 1600;
const SMALL_HEIGHT = 120;

const dir = (userData: string) => join(userData, "branding");

/** Copy an image into the app as the logo; returns its file name. */
export function importLogo(userData: string, source: string): string {
  let image = nativeImage.createFromPath(source);
  if (image.isEmpty()) throw new Error("That file isn't an image Transcriptor 2 can read. Choose a PNG or JPEG.");
  const { width, height } = image.getSize();
  if (Math.max(width, height) > MAX_SIDE) {
    image = width >= height ? image.resize({ width: MAX_SIDE, quality: "best" }) : image.resize({ height: MAX_SIDE, quality: "best" });
  }
  mkdirSync(dir(userData), { recursive: true });
  const name = `logo-${Date.now()}.png`;
  writeFileSync(join(dir(userData), name), image.toPNG());
  return name;
}

function path(userData: string, name: string): string | null {
  if (!LOGO_FILE.test(name)) return null;
  const file = join(dir(userData), name);
  return existsSync(file) ? file : null;
}

/** A small preview for Settings, as a data: URL. */
export function logoPreview(userData: string, name: string): string | null {
  const file = path(userData, name);
  if (!file) return null;
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? null : image.resize({ height: 96, quality: "best" }).toDataURL();
}

/** The logo for an export, or undefined if none is set (or its file is gone). */
export function loadLogo(userData: string, name: string): Logo | undefined {
  const file = path(userData, name);
  if (!file) return undefined;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return undefined;
  const size = image.getSize();
  const small = image.resize({ height: SMALL_HEIGHT, quality: "best" });
  return {
    png: image.toPNG(),
    ...size,
    small: { png: small.toPNG(), ...small.getSize() },
  };
}

/** Remove logo copies other than the one in use. */
export function pruneLogos(userData: string, keep: string): void {
  try {
    for (const f of readdirSync(dir(userData))) {
      if (LOGO_FILE.test(f) && f !== keep) rmSync(join(dir(userData), f), { force: true });
    }
  } catch {
    // No branding folder yet, or a file in use: try again next start.
  }
}
