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
// mediabunny (MPL-2.0) is used unmodified; its source is public, and the
// license text comes from the installed copy so the version always matches.
const mediabunny = JSON.parse(readFileSync(join(root, "node_modules/mediabunny/package.json"), "utf8"));
writeFileSync(
  join(root, "out/THIRD_PARTY_NOTICES.txt"),
  [
    "Third-party software in Transcriptor 2",
    "",
    `mediabunny ${mediabunny.version}`,
    "Cuts social clips out of episode audio. Used unmodified.",
    "License: Mozilla Public License 2.0 (full text below).",
    "Source code: https://github.com/Vanilagy/mediabunny",
    `and on npm: https://www.npmjs.com/package/mediabunny/v/${mediabunny.version}`,
    "",
    "=".repeat(72),
    "",
    readFileSync(join(root, "node_modules/mediabunny/LICENSE"), "utf8"),
  ].join("\n"),
);
