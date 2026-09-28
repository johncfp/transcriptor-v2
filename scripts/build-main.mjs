// Bundle the Electron main and preload processes with esbuild into out/.
// The renderer is built separately by Vite (out/renderer).
import { copyFileSync, mkdirSync } from "node:fs";
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
];

mkdirSync(join(root, "out"), { recursive: true });
copyFileSync(join(root, "build/icon.png"), join(root, "out/icon.png"));

await Promise.all(targets.map((t) => build({ ...common, ...t })));
