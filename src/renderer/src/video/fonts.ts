// The bundled caption fonts (SIL Open Font License; see THIRD_PARTY_NOTICES),
// registered under names of their own so a copy installed on the computer
// never changes how a video looks. Latin and Latin Extended, 600 and 700.

import atkinson600 from "@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-600-normal.woff2?url";
import atkinson600ext from "@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-600-normal.woff2?url";
import atkinson700 from "@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-700-normal.woff2?url";
import atkinson700ext from "@fontsource/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-ext-700-normal.woff2?url";
import inter600 from "@fontsource/inter/files/inter-latin-600-normal.woff2?url";
import inter600ext from "@fontsource/inter/files/inter-latin-ext-600-normal.woff2?url";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2?url";
import inter700ext from "@fontsource/inter/files/inter-latin-ext-700-normal.woff2?url";
import lexend600 from "@fontsource/lexend/files/lexend-latin-600-normal.woff2?url";
import lexend600ext from "@fontsource/lexend/files/lexend-latin-ext-600-normal.woff2?url";
import lexend700 from "@fontsource/lexend/files/lexend-latin-700-normal.woff2?url";
import lexend700ext from "@fontsource/lexend/files/lexend-latin-ext-700-normal.woff2?url";
import { VIDEO_FONTS, type VideoFontId } from "../../../shared/video";

// Fontsource's unicode ranges for its "latin" and "latin-ext" files.
const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

const FILES: Record<VideoFontId, Record<"600" | "700", [string, string]>> = {
  inter: { "600": [inter600, inter600ext], "700": [inter700, inter700ext] },
  atkinson: { "600": [atkinson600, atkinson600ext], "700": [atkinson700, atkinson700ext] },
  lexend: { "600": [lexend600, lexend600ext], "700": [lexend700, lexend700ext] },
};

const loaded = new Map<VideoFontId, Promise<void>>();

/** Load a caption font (once) so canvas text uses it; resolves when it's ready to draw. */
export function loadVideoFont(id: VideoFontId): Promise<void> {
  let ready = loaded.get(id);
  if (!ready) {
    const family = VIDEO_FONTS.find((f) => f.id === id)!.family;
    const faces = (["600", "700"] as const).flatMap((weight) => {
      const [latin, ext] = FILES[id][weight];
      return [
        new FontFace(family, `url(${latin})`, { weight, unicodeRange: LATIN }),
        new FontFace(family, `url(${ext})`, { weight, unicodeRange: LATIN_EXT }),
      ];
    });
    ready = Promise.all(faces.map((f) => f.load())).then((done) => {
      for (const face of done) document.fonts.add(face);
    });
    loaded.set(id, ready);
  }
  return ready;
}

// ---------------------------------------------------------------------------
// Chinese (Mandarin captions, subtitles S4): Noto Sans SC, bold, in the
// pieces Google Fonts cuts it into by character range (about 2.6 MB in all).
// Each piece is registered with its range and loaded only when text needs
// it; canvas text falls back to it for characters the caption font lacks.

const CJK_FILES = import.meta.glob<string>("../../../../node_modules/@fontsource/noto-sans-sc/files/noto-sans-sc-[0-9]*-700-normal.woff2", {
  eager: true,
  query: "?url",
  import: "default",
});
const CJK_RANGES = Object.values(
  import.meta.glob<Record<string, string>>("../../../../node_modules/@fontsource/noto-sans-sc/unicode.json", { eager: true, import: "default" }),
)[0]!;

/** The Chinese font's family name, after each caption font in the font list. */
export const CJK_FAMILY = "T2 Noto SC";

let cjkRegistered = false;
function registerCjk(): void {
  if (cjkRegistered) return;
  cjkRegistered = true;
  for (const [path, url] of Object.entries(CJK_FILES)) {
    const piece = /noto-sans-sc-(\d+)-700-normal/.exec(path)?.[1];
    const range = piece && CJK_RANGES[`[${piece}]`];
    if (range) document.fonts.add(new FontFace(CJK_FAMILY, `url(${url})`, { weight: "700", unicodeRange: range }));
  }
}

/** Load the pieces of the Chinese font that `text` needs, so canvas can draw it; resolves when they're ready. */
export async function loadCjkText(text: string): Promise<void> {
  registerCjk();
  await document.fonts.load(`700 40px "${CJK_FAMILY}"`, text);
}
