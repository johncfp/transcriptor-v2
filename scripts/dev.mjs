// Dev loop: Vite serves the renderer with hot reload; the main process is
// built once and Electron points at the dev server. Restart `npm run dev`
// after changing main-process code.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [join(root, "scripts/build-main.mjs")], { stdio: "inherit" });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-main exited ${code}`))));
});

const server = await createServer({ configFile: join(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls.local[0];

const electronPath = (await import("electron")).default;
const app = spawn(electronPath, [root], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
app.on("exit", async () => {
  await server.close();
  process.exit(0);
});
