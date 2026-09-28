import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";

/**
 * `npm run smoke` launches the built app with TRANSCRIPTOR_SMOKE_DIR set.
 * The app then uses that folder as its profile, waits for the UI to render,
 * checks the key store and the Settings screen, saves screenshots plus a
 * report, and quits. This checks that the build
 * boots, the preload bridge works, and the renderer mounts.
 */
const dir = process.env.TRANSCRIPTOR_SMOKE_DIR;
export const SMOKE = dir ? { dir, userData: join(dir, "profile") } : null;

export function runSmokeTest(win: BrowserWindow): void {
  if (!SMOKE) return;
  const { dir } = SMOKE;
  const finish = (report: Record<string, unknown>) => {
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  };
  const timeout = setTimeout(() => finish({ ok: false, error: "timed out" }), 20_000);

  win.webContents.once("did-finish-load", async () => {
    try {
      // Give React a moment to fetch settings and paint.
      await pause(1500);
      const probe = await win.webContents.executeJavaScript(`(async () => ({
        hasApi: typeof window.api === "object",
        heading: document.querySelector("h1")?.textContent ?? null,
        settings: window.api ? await window.api.getSettings() : null,
      }))()`);
      const settings = probe.settings;
      win.show();
      await pause(300);
      writeFileSync(join(dir, "home.png"), (await win.webContents.capturePage()).toPNG());

      // Round-trip a fake key through the keychain, then open Settings.
      const keys = await win.webContents.executeJavaScript(`(async () => {
        const saved = await window.api.setKey("elevenlabs", "sk_smoke_test_1234");
        const removed = await window.api.deleteKey("elevenlabs");
        return {
          saved: saved.find((k) => k.providerId === "elevenlabs"),
          removed: removed.find((k) => k.providerId === "elevenlabs"),
        };
      })()`);
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll(".nav-item")].find((b) => b.textContent === "Settings").click()`,
      );
      await pause(500);
      const sections = await win.webContents.executeJavaScript(
        `[...document.querySelectorAll("h2")].map((h) => h.textContent)`,
      );
      writeFileSync(join(dir, "settings.png"), (await win.webContents.capturePage()).toPNG());

      clearTimeout(timeout);
      const keyRoundTrip = keys.saved?.saved === true && keys.saved.hint === "1234" && keys.removed?.saved === false;
      finish({
        ok: probe.hasApi && probe.heading !== null && settings !== null && keyRoundTrip && sections.length >= 5,
        hasApi: probe.hasApi,
        heading: probe.heading,
        settingsIntake: settings?.processing?.intake ?? null,
        keyRoundTrip,
        sections,
      });
    } catch (err) {
      clearTimeout(timeout);
      finish({ ok: false, error: String(err) });
    }
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
