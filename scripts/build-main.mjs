// Bundle the Electron main and preload processes with esbuild into out/.
// The renderer is built separately by Vite (out/renderer).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // electron-updater ships as a normal dependency in the app's node_modules.
  external: ["electron", "electron-updater"],
  sourcemap: true,
  logLevel: "info",
};

const targets = [
  { entryPoints: [join(root, "src/main/index.ts")], outfile: join(root, "out/main/index.js") },
  // Sandboxed preloads can only require("electron"), so everything else is inlined.
  { entryPoints: [join(root, "src/preload/index.ts")], outfile: join(root, "out/preload/index.js") },
  { entryPoints: [join(root, "src/preload/cutter.ts")], outfile: join(root, "out/preload/cutter.js") },
];

mkdirSync(join(root, "out"), { recursive: true });
copyFileSync(join(root, "build/icon.png"), join(root, "out/icon.png"));
copyFileSync(join(root, "build/icon.ico"), join(root, "out/icon.ico"));

await Promise.all(targets.map((t) => build({ ...common, ...t })));

// Notices for third-party code built into the app whose license asks for one.
// Each license text comes from the installed copy, so the version always
// matches. mediabunny (MPL-2.0) is used unmodified and its source is public;
// the caption fonts are under the SIL Open Font License, which asks that the
// license go with them.
const pkg = (name) => JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
const license = (name) => readFileSync(join(root, "node_modules", name, "LICENSE"), "utf8");
const rule = "=".repeat(72);
const mediabunny = pkg("mediabunny");
const fonts = [
  ["@fontsource/inter", "Inter", "https://github.com/rsms/inter"],
  ["@fontsource/atkinson-hyperlegible-next", "Atkinson Hyperlegible Next", "https://github.com/googlefonts/atkinson-hyperlegible-next"],
  ["@fontsource/lexend", "Lexend", "https://github.com/googlefonts/lexend"],
];
writeFileSync(
  join(root, "out/THIRD_PARTY_NOTICES.txt"),
  [
    "Third-party software in Transcriptor 2",
    "",
    `mediabunny ${mediabunny.version}`,
    "Cuts social clips out of episode audio and makes video clips. Used unmodified.",
    "License: Mozilla Public License 2.0 (full text below).",
    "Source code: https://github.com/Vanilagy/mediabunny",
    `and on npm: https://www.npmjs.com/package/mediabunny/v/${mediabunny.version}`,
    "",
    ...fonts.flatMap(([name, label, source]) => [
      `${label} font (${name} ${pkg(name).version})`,
      "Used for video clip captions. License: SIL Open Font License 1.1 (full text below).",
      `Source: ${source}`,
      "",
    ]),
    rule,
    "",
    "mediabunny",
    "",
    license("mediabunny"),
    ...fonts.flatMap(([name, label]) => [rule, "", `${label} font`, "", license(name)]),
  ].join("\n"),
);
