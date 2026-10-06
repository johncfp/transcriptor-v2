// Bundles the sync check (main) and its verify page (renderer, Node on) with the repo's esbuild.
// Run from the repo root after `npm run build`; then `npx electron spikes/video-sync/ci.js`.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const require = createRequire(join(REPO, "package.json"));
const esbuild = require("esbuild");

// Vite's "?url" imports: the file's own file:// URL.
const urls = {
  name: "url",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (a) => ({ path: require.resolve(a.path.slice(0, -4)), namespace: "url" }));
    b.onLoad({ filter: /.*/, namespace: "url" }, (a) => ({ contents: `export default ${JSON.stringify(pathToFileURL(a.path).href)};`, loader: "js" }));
  },
};
const common = { bundle: true, platform: "node", format: "cjs", external: ["electron"], alias: { "@repo": REPO }, logLevel: "warning" };
// The paths the check needs at run time are baked in, so it runs from anywhere.
const define = { "process.env.REPO": JSON.stringify(REPO), "process.env.HERE": JSON.stringify(HERE) };
await esbuild.build({ ...common, define, entryPoints: [join(HERE, "ci.ts")], outfile: join(HERE, "ci.js") });
await esbuild.build({ ...common, entryPoints: [join(HERE, "verify.ts")], outfile: join(HERE, "verify.js"), plugins: [urls] });
writeFileSync(join(HERE, "verify.html"), `<!doctype html><meta charset="utf-8"><body><script src="verify.js"></script></body>`);
console.log("built");
