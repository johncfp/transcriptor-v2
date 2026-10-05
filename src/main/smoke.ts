import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { strFromU8, unzipSync } from "fflate";
import { importLogo } from "./logo";
import { fileKey } from "./watch/folderWatcher";
import { startFakeAnthropic } from "./testing/fakeAnthropic";
import type { Transcriber } from "./transcribe/types";

/**
 * `npm run smoke` launches the built app with TRANSCRIPTOR_SMOKE_DIR set.
 * The app then uses that folder as its profile and runs a scripted pass:
 * key storage, adding an audio file, transcribing it against a local fake
 * ElevenLabs, reviewing it (suggested names, filler removal, removing a word
 * by hand, marking it reviewed), writing show notes against a local fake
 * Claude API, and the Settings screen. It saves
 * screenshots plus a report, then quits.
 */
const dir = process.env.TRANSCRIPTOR_SMOKE_DIR;
export const SMOKE = dir ? { dir, userData: join(dir, "profile") } : null;

let fakeApiUrl = "";

/** In smoke mode, send transcription to the local fake instead of ElevenLabs. */
export function smokeTranscriber(real: Transcriber): Transcriber {
  if (!SMOKE) return real;
  return { ...real, transcribe: (req) => real.transcribe({ ...req, baseUrl: fakeApiUrl }) };
}

function startFakeApi(): Promise<void> {
  const words = [
    ["Hey,", 0], ["I'm", 0], ["Nigel.", 0], ["Um,", 0], ["welcome", 0], ["to", 0], ["the", 0], ["show,", 0], ["Pete.", 0],
    ["Thanks,", 1], ["uh,", 1], ["really", 1], ["glad", 1], ["to", 1], ["be", 1], ["here.", 1],
  ] as const;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          language_code: "en",
          audio_duration_secs: 4.5,
          words: words.map(([text, speaker], i) => ({
            text,
            type: "word",
            start: i * 0.5,
            end: i * 0.5 + 0.4,
            speaker_id: `speaker_${speaker}`,
            // One shaky word, to show the confidence colouring.
            logprob: text === "glad" ? -1.2 : -0.01,
          })),
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      fakeApiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

/** A valid WAV file: 9 s of silence, long enough to cover the fake words. */
function writeWav(path: string): void {
  const samples = 16000 * 9;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, buf);
}

export function runSmokeTest(win: BrowserWindow, hooks: { checkForUpdate: () => Promise<string | null> }): void {
  if (!SMOKE) return;
  const { dir } = SMOKE;
  const finish = (report: Record<string, unknown>) => {
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  };
  const timeout = setTimeout(() => finish({ ok: false, error: "timed out" }), 45_000);
  // Renderer errors go in the report, so a failed run says why.
  const consoleErrors: string[] = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") consoleErrors.push(e.message);
  });
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code);
  const shot = async (name: string) =>
    writeFileSync(join(dir, name), (await win.webContents.capturePage()).toPNG());
  const click = async (selector: string, text: string) => {
    const found = await js<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => b.textContent.includes(${JSON.stringify(text)}));
      el?.click();
      return Boolean(el);
    })()`);
    if (!found) throw new Error(`No ${selector} containing "${text}" to click`);
  };

  win.webContents.once("did-finish-load", async () => {
    try {
      await startFakeApi();
      await pause(1000);
      const probe = await js<{ hasApi: boolean; heading: string | null; intake: string | null }>(`(async () => ({
        hasApi: typeof window.api === "object",
        heading: document.querySelector("h1")?.textContent ?? null,
        intake: window.api ? (await window.api.getSettings()).processing.intake : null,
      }))()`);
      win.show();
      await pause(300);
      await shot("home.png");
      const brand = await js<string>(`document.querySelector(".brand-steps")?.textContent ?? ""`);

      // Keys: save, read back the hint, delete; then save one for the run below.
      const keys = await js<{ hint: string; removed: boolean }>(`(async () => {
        const saved = await window.api.setKey("elevenlabs", "sk_smoke_test_1234");
        const removed = await window.api.deleteKey("elevenlabs");
        await window.api.setKey("elevenlabs", "sk_smoke_test_5678");
        return {
          hint: saved.find((k) => k.providerId === "elevenlabs").hint,
          removed: !removed.find((k) => k.providerId === "elevenlabs").saved,
        };
      })()`);
      const keyRoundTrip = keys.hint === "1234" && keys.removed;

      // Exports go to the scratch folder, never the real Documents folder.
      const exportRoot = join(dir, "exports");
      await js(`window.api.updateSettings({
        show: { name: "This Is A Test Show", hosts: ["Nigel T."] },
        output: { folder: ${JSON.stringify(exportRoot)} },
      })`);

      // Pipeline: queue a file (plus one that must be rejected) and wait for the transcript.
      const wav = join(dir, "episode-386.wav");
      writeWav(wav);
      writeFileSync(join(dir, "notes.txt"), "not audio");
      const added = await js<{ added: number; rejected: string[] }>(`(async () => {
        const r = await window.api.addFiles(${JSON.stringify([wav, join(dir, "notes.txt")])});
        return { added: r.added.length, rejected: r.rejected.map((x) => x.fileName) };
      })()`);
      let status = "";
      for (let i = 0; i < 40 && status !== "needs-review" && status !== "failed"; i++) {
        await pause(150);
        status = await js<string>(`window.api.listJobs().then((j) => j[0]?.status ?? "")`);
      }
      await pause(300);
      await shot("episodes.png");

      // Review: suggested names and cleaned text, then remove "really" by hand and mark reviewed.
      await click("button", "Review");
      await pause(500);
      const readTurns = () =>
        js<string[]>(
          `[...document.querySelectorAll(".turn")].map((t) => t.querySelector(".speaker").textContent + ": " + t.querySelector("p").textContent)`,
        );
      const turns = await readTurns();
      // Playback: audio loads over t2-media://, clicking a word seeks there, playing moves the playhead.
      await pause(500);
      await click(".word", "glad");
      await pause(400);
      const seeked = await js<{ duration: number; time: number; current: string | null }>(`({
        duration: document.querySelector("audio").duration,
        time: document.querySelector("audio").currentTime,
        current: document.querySelector(".word.current")?.textContent ?? null,
      })`);
      await js(`document.querySelector("audio").play()`);
      await pause(1300);
      // "hidden" when Windows reports the window as covered: Chromium then stops
      // animation frames, and the highlight follows the audio's timeupdate events.
      const played = await js<{ time: number; current: string | null; visibility: string }>(`({
        time: document.querySelector("audio").currentTime,
        current: document.querySelector(".word.current")?.textContent ?? null,
        visibility: document.visibilityState,
      })`);
      await js(`document.querySelector("audio").pause()`);
      await pause(200);
      await shot("review.png");
      const playback =
        Math.abs(seeked.duration - 9) < 0.1 &&
        Math.abs(seeked.time - 6) < 0.05 &&
        seeked.current === "glad" &&
        played.time > 6.8 &&
        played.current !== "glad";

      await click(".word", "really");
      await pause(200);
      await click("button", "Remove word");
      await pause(300);
      const afterRemove = await readTurns();
      await click("button", "Mark as reviewed");
      await pause(300);
      const finalStatus = await js<string>(`window.api.listJobs().then((j) => j[0]?.status ?? "")`);

      // Show notes, written with the real Claude SDK against a local fake API.
      const claude = await startFakeAnthropic({
        draft: SMOKE_DRAFT,
        social: SMOKE_CLIPS,
        research: {
          searched: ["https://pete.example/"],
          input: {
            identified: true,
            facts: [{ fact: "Pete hosts a podcast.", source_urls: ["https://pete.example/"] }],
            links: [{ label: "Website", url: "https://pete.example/" }],
          },
        },
      });
      await js(`(async () => {
        await window.api.setKey("anthropic", "sk-ant-smoke");
        await window.api.updateSettings({ writing: { provider: "anthropic", model: "", baseUrl: ${JSON.stringify(claude.url)} } });
        // Social clips follow the notes; the episode is 8 s, so allow short clips.
        await window.api.updateSettings({ social: { enabled: true, baseUrl: ${JSON.stringify(claude.url)}, minClips: 1, minSeconds: 5, maxSeconds: 20 } });
      })()`);
      await click("button", "Write show notes");
      let notesStatus = "";
      for (let i = 0; i < 60 && notesStatus !== "written" && notesStatus !== "failed"; i++) {
        await pause(150);
        notesStatus = await js<string>(`window.api.listJobs().then((j) => j[0]?.status ?? "")`);
      }
      // Then the social clips step, with its own model (Sonnet by default) and effort.
      let social: { status?: string; clipCount?: number; error?: string } | null = null;
      for (let i = 0; i < 60 && social?.status !== "done" && social?.status !== "failed"; i++) {
        await pause(150);
        social = await js(`window.api.listJobs().then((j) => j[0]?.social ?? null)`);
      }
      const socialRequest = claude.requests.find((r) => r.body.stream && JSON.stringify(r.body.output_config ?? {}).includes('"clips"'))?.body;
      const socialStep =
        social?.status === "done" &&
        social.clipCount === 1 &&
        notesStatus === "written" &&
        socialRequest?.model === "claude-sonnet-5-5" &&
        (socialRequest?.output_config as { effort?: string } | undefined)?.effort === "medium";
      await js(`window.api.updateSettings({ social: { enabled: false, minClips: 3, minSeconds: 15, maxSeconds: 60 } })`);

      // Review the clip: keep it, end it a word earlier, edit a caption; the changes are checked and saved.
      await click(".tab", "Clips");
      await pause(800);
      await shot("clips.png");
      const clipsView = await js<{ cards: number; text: string; captions: number; fullWidth: boolean }>(`({
        cards: document.querySelectorAll(".clip-card").length,
        text: document.querySelector(".clip-lines")?.innerText ?? "",
        captions: document.querySelectorAll(".caption-editor").length,
        // Caption boxes fill their editor.
        fullWidth: [...document.querySelectorAll(".caption-editor .input")].every(
          (el) => Math.round(el.getBoundingClientRect().width) === Math.round(el.parentElement.getBoundingClientRect().width),
        ),
      })`);
      await click(".clip-card button", "Play clip");
      await pause(400);
      const clipPlayback = await js<{ paused: boolean; time: number; label: string }>(`({
        paused: document.querySelector(".review-main audio").paused,
        time: document.querySelector(".review-main audio").currentTime,
        label: [...document.querySelectorAll(".clip-card button")].find((b) => b.textContent === "Stop")?.textContent ?? "",
      })`);
      await click(".clip-card button", "Stop");
      await click(".clip-card button", "Keep");
      await pause(200);
      await js(`document.querySelector("button[aria-label='End one word earlier']").click()`);
      await pause(200);
      await js(`(() => {
        const box = document.querySelector("textarea[aria-label='X / Threads caption']");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Pete joins the show, in 2031.");
        box.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await pause(1200);
      await shot("clips-edited.png");
      const jobId = await js<string>(`window.api.listJobs().then((j) => j[0].id)`);
      const savedClip = await js<{ kept: boolean; lines: { text: string }[]; captions: { x?: { text: string; problems: string[] } } } | null>(
        `window.api.getSocial(${JSON.stringify(jobId)}).then((s) => s?.clips[0] ?? null)`,
      );
      const clipsReview =
        clipsView.cards === 1 &&
        clipsView.text.includes("Pete: Thanks, glad to be here.") &&
        clipsView.captions === 2 &&
        clipsView.fullWidth &&
        !clipPlayback.paused &&
        clipPlayback.label === "Stop" &&
        savedClip?.kept === true &&
        savedClip.lines.at(-1)?.text === "Thanks, glad to be" &&
        savedClip.captions.x?.text === "Pete joins the show, in 2031." &&
        savedClip.captions.x?.problems.some((p) => p.includes("2031")) === true;
      // Back to the notes, where the next checks look.
      await click(".tab", "Show notes");
      await pause(500);
      await pause(500);
      const notesText = await js<string>(`document.querySelector(".doc")?.innerText ?? ""`);
      const checksText = await js<string>(`document.querySelector(".review-side")?.innerText ?? ""`);
      await shot("notes.png");
      // Auto-export ran when the notes finished (DOCX is the default format).
      const exported = await js<{ folder: string; files: string[] } | null>(
        `window.api.listJobs().then((j) => j[0]?.exported ?? null)`,
      );
      const exportOk =
        exported !== null &&
        exported.folder.startsWith(exportRoot) &&
        exported.files.length === 3 &&
        exported.files.every((f) => f.endsWith(".docx") && existsSync(f));
      // PDF: each document printed through Chromium, with no temporary page left behind.
      const pdfExport = await js<{ folder: string; files: string[] }>(
        `window.api.listJobs().then((j) => window.api.exportEpisode(j[0].id, ["pdf"]))`,
      );
      const pdfOk =
        pdfExport.files.length === 3 &&
        pdfExport.files.every((f) => f.endsWith(".pdf") && readFileSync(f).subarray(0, 5).toString() === "%PDF-") &&
        !readdirSync(pdfExport.folder).some((f) => f.startsWith(".t2-print"));
      // Branding: the app icon as the logo, then a Word and PDF export with a cover, header and footer.
      const logo = importLogo(app.getPath("userData"), join(__dirname, "..", "icon.png"));
      await js(`window.api.updateSettings({ output: { branding: {
        coverPage: true, logo: ${JSON.stringify(logo)}, logoInHeader: true,
        headerText: "Confidential", footerText: "© 2026 Smoke Test", pageNumbers: true } } })`);
      const branded = await js<{ folder: string; files: string[] }>(
        `window.api.listJobs().then((j) => window.api.exportEpisode(j[0].id, ["docx", "pdf"]))`,
      );
      const brandedDocx = unzipSync(readFileSync(branded.files.find((f) => f.endsWith("Show Notes.docx"))!));
      const brandingOk =
        branded.files.length === 6 &&
        !!brandedDocx["word/header1.xml"] &&
        !!brandedDocx["word/footer1.xml"] &&
        !!brandedDocx["word/media/logo.png"] &&
        strFromU8(brandedDocx["word/document.xml"]!).includes("<w:titlePg/>") &&
        branded.files.filter((f) => f.endsWith(".pdf")).every((f) => readFileSync(f).subarray(0, 5).toString() === "%PDF-");
      await js(`[...document.querySelectorAll("h2")].find((h) => h.textContent === "Export").scrollIntoView()`);
      await pause(300);
      await shot("export.png");
      await click("button", "Reference file");
      await pause(300);
      const referenceText = await js<string>(`document.querySelector(".doc")?.innerText ?? ""`);
      await shot("reference.png");
      const notes =
        notesStatus === "written" &&
        notesText.includes("Episode 386: Showing Up with Pete") &&
        notesText.includes("“Welcome to the show, Pete.”") &&
        !notesText.includes("We are so glad you came") &&
        notesText.includes("https://pete.example/") &&
        exportOk &&
        pdfOk &&
        brandingOk &&
        checksText.includes("1 quote left out") &&
        referenceText.includes("Thanks, glad to be here.") &&
        referenceText.includes("Pete hosts a podcast.");

      // Settings: every section is on one of the tabs.
      await click(".nav-item", "Settings");
      await pause(500);
      const sections: string[] = [];
      for (const [label, file] of [
        ["General", "settings-general.png"],
        ["Output", "settings-output.png"],
        ["Show notes", "settings-notes.png"],
        ["Social", "settings-social.png"],
        ["Drive", "settings-drive.png"],
        ["API keys", "settings-keys.png"],
      ] as const) {
        await click(".tab", label);
        await pause(300);
        sections.push(...(await js<string[]>(`[...document.querySelectorAll(".settings-grid h2")].map((h) => h.textContent)`)));
        await shot(file);
      }
      await click(".tab", "Output");
      await pause(600);
      await js(`[...document.querySelectorAll("h2")].find((h) => h.textContent === "Cover page, header and footer").scrollIntoView()`);
      await pause(500);
      await shot("settings-branding.png");

      // Model and effort: the live list from the fake Claude API, the default model, and Auto effort.
      await click(".tab", "Show notes");
      await pause(800);
      await js(`[...document.querySelectorAll("h2")].find((h) => h.textContent === "Show notes").scrollIntoView()`);
      await pause(400);
      const modelOptions = await js<string[]>(`[...document.querySelectorAll("select[aria-label=Model] option")].map((o) => o.textContent)`);
      const effortOptions = await js<string[]>(`[...document.querySelectorAll("select[aria-label=Effort] option")].map((o) => o.textContent)`);
      const selectWidths = await js<number[]>(
        `["Model", "Effort"].map((l) => document.querySelector("select[aria-label=" + l + "]")?.getBoundingClientRect().width ?? 0)`,
      );
      await shot("settings-model.png");
      // A saved model Claude doesn't list is flagged, not silently kept.
      await js(`window.api.updateSettings({ writing: { model: "hertzog" } })`);
      await click(".nav-item", "Episodes");
      await pause(300);
      await click(".nav-item", "Settings");
      await pause(300);
      await click(".tab", "Show notes");
      await pause(800);
      const unknownModel = await js<{ hint: string; selected: string }>(`(() => {
        const select = document.querySelector("select[aria-label=Model]");
        return { hint: select.closest(".row").querySelector(".hint.error")?.textContent ?? "", selected: select.selectedOptions[0]?.textContent ?? "" };
      })()`);
      await js(`window.api.updateSettings({ writing: { model: "" } })`);
      // Social tab: its own model (Sonnet by default, medium effort) and voice, off until turned on.
      await click(".tab", "Social");
      await pause(800);
      const socialPicker = await js<{ model: string; effort: string; switchOn: boolean; voices: number; clips: string[] }>(`({
        model: document.querySelector("select[aria-label=Model]")?.selectedOptions[0]?.textContent ?? "",
        effort: document.querySelector("select[aria-label=Effort]")?.value ?? "",
        switchOn: document.querySelector(".switch").checked,
        voices: document.querySelectorAll("input[name=social-voice]").length,
        clips: ["Fewest clips", "Most clips", "Shortest clip", "Longest clip"].map((l) => document.querySelector("input[aria-label='" + l + "']")?.value ?? ""),
      })`);
      const socialOk =
        socialPicker.model === "Default (Claude Sonnet 5.5)" &&
        socialPicker.effort === "medium" &&
        !socialPicker.switchOn &&
        socialPicker.voices === 4 &&
        JSON.stringify(socialPicker.clips) === JSON.stringify(["3", "5", "15", "60"]);
      claude.close();
      const draftRequest = claude.requests.find((r) => r.body.stream)?.body;
      const modelPicker =
        JSON.stringify(modelOptions) ===
          JSON.stringify([
            "Default (Claude Opus 5.5)",
            "Claude Opus 5.5 (claude-opus-5-5)",
            "Claude Sonnet 5.5 (claude-sonnet-5-5)",
            "Claude Opus 5 (claude-opus-5)",
          ]) &&
        JSON.stringify(effortOptions) === JSON.stringify(["Auto", "Low", "Medium", "High", "Extra high", "Max"]) &&
        draftRequest?.model === "claude-opus-5-5" &&
        unknownModel.hint.includes("doesn't list a model called “hertzog”") &&
        unknownModel.selected === "hertzog (not available)" &&
        selectWidths[0]! > 0 &&
        selectWidths[0] === selectWidths[1] &&
        (draftRequest?.output_config as { effort?: string } | undefined)?.effort === undefined;
      await click(".tab", "General");
      await pause(300);

      // Themes: the page background follows the choice.
      const background = () => js<string>(`getComputedStyle(document.body).backgroundColor`);
      await js(`window.api.updateSettings({ general: { theme: "light" } })`);
      await pause(400);
      const lightBg = await background();
      await shot("theme-light.png");
      await js(`window.api.updateSettings({ general: { theme: "dark" } })`);
      await pause(400);
      const darkBg = await background();
      const themes = lightBg === "rgb(247, 247, 248)" && darkBg === "rgb(17, 17, 19)";

      // Save: a change stays a draft until saved, and leaving Settings asks first.
      await click(".tab", "General");
      await pause(200);
      const reviewSwitch = `[...document.querySelectorAll(".toggle-row")].find((r) => r.textContent.includes("Review the transcript")).querySelector("input")`;
      const savedReview = () => js<boolean>(`window.api.getSettings().then((s) => s.processing.reviewStep)`);
      const heading = () => js<string>(`document.querySelector("h1")?.textContent ?? ""`);
      const unsavedShown = () => js<boolean>(`document.body.innerText.includes("Unsaved changes")`);
      await js(`${reviewSwitch}.click()`);
      await pause(200);
      const dirtyShown = (await unsavedShown()) && (await savedReview()) === true;
      await click(".nav-item", "Episodes");
      await pause(300);
      const promptShown = await js<boolean>(`document.querySelector(".modal") !== null`);
      await shot("unsaved.png");
      await click(".modal button", "Keep editing");
      await pause(200);
      const stayed = (await heading()) === "Settings" && (await unsavedShown());
      await click(".nav-item", "Episodes");
      await pause(300);
      await click(".modal button", "Discard");
      await pause(300);
      const discarded = (await heading()) === "Episodes" && (await savedReview()) === true;
      await click(".nav-item", "Settings");
      await pause(300);
      await js(`${reviewSwitch}.click()`);
      await pause(200);
      await click(".settings-head button", "Save");
      await pause(300);
      const savedOk = (await savedReview()) === false && !(await unsavedShown());
      const version = await js<string>(`document.querySelector(".version")?.textContent ?? ""`);
      await js(`window.api.updateSettings({ processing: { reviewStep: true } })`);
      const saveFlow = dirtyShown && promptShown && stayed && discarded && savedOk;

      // Custom voice: picking it shows an editor for your own instruction.
      await click(".tab", "API keys");
      await pause(200);
      await click(".voice-option", "Custom");
      await pause(200);
      const customVoice = await js<boolean>(`document.querySelector(".voice-options + .field textarea") !== null`);
      await js(`document.querySelector(".voice-options + .field textarea").scrollIntoView()`);
      await pause(200);
      await shot("custom-voice.png");
      await click(".settings-head button", "Discard");
      await pause(200);

      // Full-screen size: settings sections side by side; Episodes fills the width; search filters.
      win.setSize(1900, 1000);
      // Resizing is asynchronous; wait for the page to see the new width.
      let pageWidth = 0;
      for (let i = 0; i < 30 && pageWidth < 1400; i++) {
        await pause(100);
        pageWidth = await js<number>(`window.innerWidth`);
      }
      await js(`window.scrollTo(0, 0); document.querySelector(".content").scrollTop = 0`);
      await shot("settings-wide.png");
      const settingsColumns = await js<number>(
        `new Set([...document.querySelectorAll(".settings-grid > .section")].map((s) => Math.round(s.getBoundingClientRect().left))).size`,
      );
      // Show notes tab, two columns: the provider settings sit right under the show profile.
      await click(".tab", "Show notes");
      await pause(400);
      const notesLayout = await js<{ profile: number[]; notes: number[] }>(`(() => {
        const box = (t) => { const r = [...document.querySelectorAll(".settings-grid > .section")].find((s) => s.querySelector("h2").textContent === t).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.bottom)]; };
        return { profile: box("Show profile"), notes: box("Show notes") };
      })()`);
      await shot("settings-notes-wide.png");
      const notesStacked =
        pageWidth < 1400 ||
        (notesLayout.profile[0] === notesLayout.notes[0] && Math.abs(notesLayout.notes[1]! - notesLayout.profile[2]! - 18) <= 2);
      await click(".tab", "General");
      await pause(200);
      await click(".nav-item", "Episodes");
      await pause(400);
      const typeSearch = async (text: string) => {
        await js(`(() => { const i = document.querySelector("input.search"); i.focus(); i.select(); })()`);
        win.webContents.insertText(text);
        await pause(300);
        return js<{ rows: number; empty: boolean }>(`({
          rows: document.querySelectorAll(".job").length,
          empty: document.body.innerText.includes("No episodes match"),
        })`);
      };
      const stageColor = await js<string>(`getComputedStyle(document.querySelector(".job")).borderLeftColor`);
      const searchHit = await typeSearch("showing pete");
      await shot("episodes-wide.png");
      const searchMiss = await typeSearch("zzz");
      const search = searchHit.rows === 1 && !searchHit.empty && searchMiss.rows === 0 && searchMiss.empty;

      // Packaged builds only: can the public releases feed be read without a token?
      // Drive: a watched folder skips what's already there, picks up a new file in a
      // subfolder, and moves it into Done once transcribed; exports go next to it.
      const driveRoot = join(dir, "drive");
      mkdirSync(join(driveRoot, "Show A"), { recursive: true });
      copyFileSync(wav, join(driveRoot, "already there.wav"));
      await js(`window.api.updateSettings({ folderWatch: { enabled: true, folder: ${JSON.stringify(driveRoot)} } })`);
      await pause(1500); // the first look only notes what's there
      copyFileSync(wav, join(driveRoot, "Show A", "Episode 2.wav"));
      type WatchedJob = { id: string; fileName: string; status: string; watchedPath?: string; exportRoot?: string };
      let watched: WatchedJob | undefined;
      for (let i = 0; i < 60 && !(watched && ["needs-review", "ready"].includes(watched.status)); i++) {
        await pause(500);
        watched = (await js<WatchedJob[]>(`window.api.listJobs()`)).find((j) => j.watchedPath);
        if (watched?.status === "awaiting-approval") await js(`window.api.approveJob(${JSON.stringify(watched.id)})`);
      }
      const movedToDone = join(driveRoot, "Done", "Show A", "Episode 2.wav");
      for (let i = 0; i < 20 && !existsSync(movedToDone); i++) await pause(250);
      const claimsDir = join(driveRoot, ".transcriptor", "claims");

      // A file another computer claimed an hour ago and never finished: listed as
      // stuck on the Drive tab, and taken over from there.
      const stuckRel = join("Show B", "Stuck episode.wav");
      mkdirSync(join(driveRoot, "Show B"), { recursive: true });
      mkdirSync(claimsDir, { recursive: true });
      writeFileSync(
        join(claimsDir, `${fileKey(stuckRel, statSync(wav).size)}.studio-pc.json`),
        JSON.stringify({ machine: "studio-pc", name: "Studio PC", at: Date.now() - 3_600_000, file: "Show B/Stuck episode.wav" }),
      );
      copyFileSync(wav, join(driveRoot, stuckRel));
      await click(".nav-item", "Settings");
      await pause(300);
      await click(".tab", "Drive");
      let stuckRows = 0;
      for (let i = 0; i < 40 && stuckRows === 0; i++) {
        await pause(500);
        stuckRows = await js<number>(`document.querySelectorAll(".stuck-list li").length`);
      }
      await js(`document.querySelector(".stuck-list")?.scrollIntoView()`);
      await pause(300);
      await shot("settings-drive-stuck.png");
      const stuckText = await js<string>(`document.querySelector(".stuck-list")?.textContent ?? ""`);
      await click(".stuck-list button", "Take over");
      let takenOver: WatchedJob | undefined;
      for (let i = 0; i < 60 && !(takenOver && ["needs-review", "ready"].includes(takenOver.status)); i++) {
        await pause(500);
        takenOver = (await js<WatchedJob[]>(`window.api.listJobs()`)).find((j) => j.watchedPath === stuckRel);
        if (takenOver?.status === "awaiting-approval") await js(`window.api.approveJob(${JSON.stringify(takenOver.id)})`);
      }
      const stuckDone = join(driveRoot, "Done", stuckRel);
      for (let i = 0; i < 20 && !existsSync(stuckDone); i++) await pause(250);
      const takeOver = {
        rows: stuckRows,
        text: stuckText,
        status: takenOver?.status ?? null,
        movedToDone: existsSync(stuckDone),
      };
      await click(".tab", "General");
      await pause(200);
      await click(".nav-item", "Episodes");
      await pause(200);

      const folderWatch = {
        job: watched ?? null,
        movedToDone: existsSync(movedToDone),
        originalGone: !existsSync(join(driveRoot, "Show A", "Episode 2.wav")),
        existingLeft: existsSync(join(driveRoot, "already there.wav")),
        claimsLeft: existsSync(claimsDir) ? readdirSync(claimsDir).length : 0,
        jobs: (await js<WatchedJob[]>(`window.api.listJobs()`)).filter((j) => j.watchedPath).length,
        takeOver,
      };
      await js(`window.api.updateSettings({ folderWatch: { enabled: false } })`);
      const folderWatchOk =
        folderWatch.job?.watchedPath === join("Show A", "Episode 2.wav") &&
        folderWatch.job.fileName === "Episode 2.wav" &&
        folderWatch.job.exportRoot === join(driveRoot, "Transcriptor Exports") &&
        folderWatch.movedToDone &&
        folderWatch.originalGone &&
        folderWatch.existingLeft &&
        folderWatch.claimsLeft === 0 &&
        folderWatch.jobs === 2 &&
        takeOver.rows === 1 &&
        takeOver.text.includes("Stuck episode.wav") &&
        takeOver.text.includes("Claimed by Studio PC 1 hour ago") &&
        takeOver.status !== null &&
        takeOver.movedToDone;

      const newerVersion = app.isPackaged ? await hooks.checkForUpdate() : "skipped (not packaged)";

      // The window's taskbar icon ships next to the main bundle.
      const windowIcon = existsSync(join(__dirname, "..", process.platform === "win32" ? "icon.ico" : "icon.png"));

      clearTimeout(timeout);
      const pipeline = added.added === 1 && added.rejected[0] === "notes.txt" && status === "needs-review";
      const review =
        turns[0] === "Nigel T.: Hey, I'm Nigel. Welcome to the show, Pete." &&
        turns[1] === "Pete: Thanks, really glad to be here." &&
        afterRemove[1] === "Pete: Thanks, glad to be here." &&
        finalStatus === "ready";
      finish({
        ok:
          probe.hasApi &&
          probe.heading === "Episodes" &&
          probe.intake === "approve" &&
          keyRoundTrip &&
          pipeline &&
          review &&
          playback &&
          notes &&
          search &&
          // Two columns need ~1400px; skip on a screen too small for that.
          (pageWidth < 1400 || settingsColumns === 2) &&
          notesStacked &&
          themes &&
          saveFlow &&
          customVoice &&
          stageColor === "rgb(21, 128, 61)" &&
          win.getTitle() === "Transcriptor 2 — just transcribe" &&
          brand === "Upload | Transcribe | Export" &&
          /^Transcriptor 2 v2\.0\.0/.test(version) &&
          ALL_SECTIONS.every((t) => sections.includes(t)) &&
          modelPicker &&
          socialOk &&
          socialStep &&
          clipsReview &&
          folderWatchOk &&
          // The template comes before the provider and model on the Show notes tab.
          sections.indexOf("Show notes template") < sections.indexOf("Show notes") &&
          windowIcon,
        checks: { pipeline, review, playback, notes, pdfOk, brandingOk, modelPicker, socialOk, socialStep, clipsReview, folderWatchOk, search, themes, saveFlow, customVoice },
        folderWatch,
        modelOptions,
        effortOptions,
        selectWidths,
        unknownModel,
        socialPicker,
        social,
        clipsView,
        clipPlayback,
        savedClip,
        heading: probe.heading,
        intake: probe.intake,
        keyRoundTrip,
        added,
        status,
        turns,
        afterRemove,
        seeked,
        played,
        finalStatus,
        notesStatus,
        exported,
        pdfExport,
        branded,
        notesText,
        sections,
        windowIcon,
        settingsColumns,
        notesLayout,
        pageWidth,
        saveFlow: { dirtyShown, promptShown, stayed, discarded, savedOk },
        stageColor,
        customVoice,
        title: win.getTitle(),
        brand,
        version,
        lightBg,
        darkBg,
        searchHit,
        searchMiss,
        newerVersion,
      });
    } catch (err) {
      clearTimeout(timeout);
      finish({ ok: false, error: String(err), consoleErrors });
    }
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fake Claude API's show-notes draft: one real quote, one invented one (must be dropped). */
const SMOKE_DRAFT = {
  title_suggestion: "Showing Up with Pete",
  summary: "Nigel welcomes Pete to This Is A Test Show.",
  about_guest: "Pete is glad to be here.",
  timestamps: [
    { time: "00:00", label: "Welcome" },
    { time: "00:04", label: "Pete says thanks" },
  ],
  topics: [{ title: "Welcomes", points: ["Being glad to be here"] }],
  quotes: [{ text: "Welcome to the show, Pete." }, { text: "We are so glad you came." }],
  rapid_fire: [],
  takeaways: ["Say thanks."],
  resources: [],
  reference: {
    topics: ["Welcomes"],
    keywords: ["welcome", "show"],
    high_notes: ["Gratitude opens a conversation."],
    quotes: [{ text: "Thanks, glad to be here." }],
    frameworks: [],
  },
};

/**
 * One clip across both speakers, quoting the transcript as reviewed: the
 * fillers ("Um," "uh,") are cleaned out and review removed "really".
 */
const SMOKE_CLIPS = {
  clips: [
    {
      title: "A warm welcome",
      why: "Short and friendly.",
      first_words: "Hey, I'm Nigel. Welcome to",
      last_words: "Thanks, glad to be here.",
      captions: { instagram: { text: "Pete joins the show.", hashtags: ["podcast"] }, x: { text: "Pete joins the show.", hashtags: [] } },
    },
  ],
};

/** Every settings section, which between them the tabs must show. */
const ALL_SECTIONS = [
  "General",
  "Processing",
  "Output",
  "Cover page, header and footer",
  "Confidence bands",
  "Show profile",
  "Show notes",
  "Show notes template",
  "API keys",
  "Show notes voice",
  "Social clips",
  "Social voice",
  "Watch a Drive folder",
];
