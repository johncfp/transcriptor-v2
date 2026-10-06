// Video clip feasibility spike (milestone 7.0), run by .github/workflows/video-spike.yml
// on macOS and Windows runners: can Electron's Chromium encode an H.264 MP4 with
// captions and audio on its own? Writes out/report.json, MP4s and a still.
// Uses generated audio and words, so no episode audio leaves the computer.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });
app.setPath("userData", path.join(OUT, "profile"));
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const report = {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    gpu: app.getGPUFeatureStatus(),
  };
  try {
    report.gpuInfo = await app.getGPUInfo("basic");
  } catch (e) {
    report.gpuInfo = String(e);
  }
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (e) => console.log("[page]", e.message));
  const timer = setTimeout(() => finish({ error: "Timed out after 20 minutes." }), 20 * 60_000);
  const finish = (page) => {
    clearTimeout(timer);
    Object.assign(report, page);
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    app.exit(report.error ? 1 : 0);
  };
  ipcMain.once("done", (_e, page) => finish(page));
  win.webContents.on("render-process-gone", (_e, d) => finish({ error: `Page gone: ${d.reason}` }));
  win.loadFile(path.join(__dirname, "runner.html"));
});
