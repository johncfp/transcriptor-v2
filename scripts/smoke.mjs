// Launch the built app against a throwaway profile, let it render, and read
// back the report it writes (see src/main/smoke.ts). Exits non-zero on failure.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.SMOKE_OUT ?? mkdtempSync(join(tmpdir(), "transcriptor2-smoke-"));
const electronPath = (await import("electron")).default;

const code = await new Promise((resolve) => {
  const p = spawn(electronPath, [root], {
    stdio: "inherit",
    env: { ...process.env, TRANSCRIPTOR_SMOKE_DIR: dir },
  });
  p.on("exit", resolve);
});

let report;
try {
  report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
} catch {
  report = { ok: false, error: "no report written" };
}
console.log(JSON.stringify({ ...report, screenshots: dir }, null, 2));
process.exit(code === 0 && report.ok ? 0 : 1);
