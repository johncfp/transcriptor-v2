// The spike's page: encoder support, then real renders of a captioned clip in
// each shape, each checked by reopening the MP4. See main.js.
const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const mb = require("../../node_modules/mediabunny/dist/bundles/mediabunny.cjs");

const OUT = path.join(__dirname, "out");
const FPS = 30;
const RATE = 44100;
const mem = () => Math.round(process.memoryUsage().rss / 1e6);
const FONT = "-apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

// --- Generated audio and words (no episode audio leaves the computer) ---------
function audio(seconds) {
  const pcm = new Float32Array(seconds * RATE);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    const env = 0.15 + 0.35 * Math.abs(Math.sin(t * 2.7) * Math.sin(t * 0.9 + 1));
    pcm[i] = env * (0.5 * Math.sin(2 * Math.PI * 180 * t) + 0.25 * Math.sin(2 * Math.PI * 1100 * t) + 0.25 * rnd());
  }
  return pcm;
}
const TEXT =
  "So yeah it was a great opportunity great experience and I learned so much about how farmers actually make decisions. You have to spend time with them on the farm, not just in the office. If you're talking to a college graduate who's about to start, tell them to listen first.";
function words(seconds) {
  const list = TEXT.split(" ");
  const out = [];
  let t = 0.3, n = 0, speaker = "Delaney Howell";
  while (t < seconds - 0.5) {
    const text = list[n % list.length];
    const d = 0.18 + text.length * 0.035;
    out.push({ text, start: t, end: t + d, speaker });
    t += d + 0.07 + (/[.,]$/.test(text) ? 0.35 : 0);
    if (/\.$/.test(text) && ++n % 7 === 0) speaker = speaker === "Delaney Howell" ? "Brian" : "Delaney Howell";
    n++;
  }
  return out;
}

// --- One frame, in any shape ---------------------------------------------------
function layoutPages(ctx, ws, maxWidth, linesPerPage) {
  const lines = [];
  let line = [];
  for (const w of ws) {
    const test = [...line, w].map((x) => x.text).join(" ");
    if (line.length && (ctx.measureText(test).width > maxWidth || w.speaker !== line[0].speaker)) {
      lines.push(line);
      line = [];
    }
    line.push(w);
  }
  if (line.length) lines.push(line);
  const pages = [];
  for (const l of lines) {
    const page = pages.at(-1);
    if (page && page.length < linesPerPage && page[0][0].speaker === l[0].speaker) page.push(l);
    else pages.push([l]);
  }
  return pages.map((p) => ({ lines: p, start: p[0][0].start, end: p.at(-1).at(-1).end, speaker: p[0][0].speaker }));
}

function makeDrawer(ctx, W, H, ws, pcm) {
  const unit = Math.min(W, H) / 1080; // sizes scale with the shorter side
  const capSize = Math.round(76 * unit * (W > H ? 0.9 : 1));
  ctx.font = `bold ${capSize}px ${FONT}`;
  const pages = layoutPages(ctx, ws, W - 160 * unit, W > H ? 2 : 3);
  const per = Math.round(RATE / FPS);
  const levels = Array.from({ length: Math.ceil(pcm.length / per) }, (_, f) => {
    let s = 0;
    for (let i = f * per; i < Math.min(pcm.length, (f + 1) * per); i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / per);
  });
  const peak = Math.max(...levels) || 1;
  return (t) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#14213d");
    g.addColorStop(1, "#0b0f1a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const logo = 150 * unit;
    const top = H > W ? 180 * unit : 70 * unit;
    ctx.fillStyle = "#fca311";
    ctx.beginPath();
    ctx.roundRect(W / 2 - logo / 2, top, logo, logo, 30 * unit);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = "#14213d";
    ctx.font = `bold ${Math.round(48 * unit)}px ${FONT}`;
    ctx.fillText("LOGO", W / 2, top + logo / 2 + 17 * unit);
    const f = Math.floor(t * FPS);
    const bars = 60;
    const span = W - 180 * unit;
    for (let b = 0; b < bars; b++) {
      const lv = levels[f - bars + 1 + b] ?? 0;
      const h = 8 * unit + (lv / peak) * 200 * unit;
      ctx.fillStyle = b === bars - 1 ? "#fca311" : "rgba(229,229,229,0.55)";
      ctx.fillRect(90 * unit + (b * span) / bars, H - 300 * unit - h / 2, Math.max(2, (span / bars) * 0.6), h);
    }
    const page = pages.find((p) => t < p.end + 0.3) ?? pages.at(-1);
    if (page && t >= page.start - 0.3) {
      const capTop = H > W ? H * 0.42 : H * 0.42;
      ctx.textAlign = "left";
      ctx.font = `600 ${Math.round(44 * unit)}px ${FONT}`;
      ctx.fillStyle = "#fca311";
      ctx.fillText(page.speaker, 80 * unit, capTop - 110 * unit);
      ctx.font = `bold ${capSize}px ${FONT}`;
      page.lines.forEach((line, li) => {
        let x = 80 * unit;
        const y = capTop + li * capSize * 1.4;
        for (const w of line) {
          const width = ctx.measureText(w.text).width;
          const now = t >= w.start && t < w.end + 0.08;
          if (now) {
            ctx.fillStyle = "#fca311";
            ctx.beginPath();
            ctx.roundRect(x - 12 * unit, y - capSize * 0.95, width + 24 * unit, capSize * 1.25, 14 * unit);
            ctx.fill();
          }
          ctx.fillStyle = now ? "#14213d" : t >= w.start ? "#ffffff" : "rgba(255,255,255,0.4)";
          ctx.fillText(w.text, x, y);
          x += width + ctx.measureText(" ").width;
        }
      });
    }
  };
}

// --- Render one clip and check it ----------------------------------------------
async function render({ label, W, H, seconds, hw }) {
  const pcm = audio(seconds);
  const ws = words(seconds);
  const canvas = new OffscreenCanvas(W, H);
  const draw = makeDrawer(canvas.getContext("2d"), W, H, ws, pcm);
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
  const video = new mb.CanvasSource(canvas, { codec: "avc", bitrate: 6e6, keyFrameInterval: 2, hardwareAcceleration: hw });
  const sound = new mb.AudioSampleSource({ codec: "aac", bitrate: 128000 });
  output.addVideoTrack(video, { frameRate: FPS });
  output.addAudioTrack(sound);
  await output.start();
  const t0 = performance.now();
  let peak = mem();
  for (let f = 0; f < seconds * FPS; f++) {
    const t = f / FPS;
    if (f % FPS === 0) {
      const a = Math.round(t * RATE), b = Math.min(pcm.length, a + RATE);
      if (b > a) await sound.add(new mb.AudioSample({ data: pcm.slice(a, b), format: "f32-planar", numberOfChannels: 1, sampleRate: RATE, timestamp: t }));
    }
    draw(t);
    await video.add(t, 1 / FPS);
    if (f % 300 === 0) peak = Math.max(peak, mem());
  }
  video.close();
  sound.close();
  await output.finalize();
  const ms = Math.round(performance.now() - t0);
  const bytes = new Uint8Array(output.target.buffer);
  const file = path.join(OUT, `${label}.mp4`);
  fs.writeFileSync(file, bytes);

  const check = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
  const vt = await check.getPrimaryVideoTrack();
  const frame = await new mb.VideoSampleSink(vt).getSample(Math.min(10.4, seconds / 2));
  let still = null;
  if (frame) {
    const c = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    frame.draw(c.getContext("2d"), 0, 0);
    still = `${label}.png`;
    fs.writeFileSync(path.join(OUT, still), Buffer.from(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()));
    frame.close();
  }
  const stats = await vt.computePacketStats();
  const result = {
    ms,
    realtimeX: +(seconds / (ms / 1000)).toFixed(2),
    mb: +(bytes.length / 1e6).toFixed(1),
    kbps: Math.round(stats.averageBitrate / 1000),
    peakRssMb: peak,
    duration: +(await check.computeDuration()).toFixed(2),
    tracks: (await check.getTracks()).map((t) => `${t.type}:${t.codec}`),
    codec: await vt.getCodecParameterString(),
    size: `${vt.displayWidth}x${vt.displayHeight}`,
    still,
  };
  check.dispose();
  return result;
}

async function support() {
  const out = {};
  const codecs = { "h264 high": "avc1.640028", "h264 main": "avc1.4d0028", "h264 baseline": "avc1.42e028", vp9: "vp09.00.40.08", av1: "av01.0.08M.08", hevc: "hvc1.1.6.L120.B0" };
  for (const [name, codec] of Object.entries(codecs)) {
    for (const hw of ["prefer-hardware", "prefer-software", "no-preference"]) {
      try {
        out[`${name} / ${hw}`] = (await VideoEncoder.isConfigSupported({ codec, width: 1080, height: 1920, bitrate: 6e6, framerate: FPS, hardwareAcceleration: hw })).supported;
      } catch (e) {
        out[`${name} / ${hw}`] = "error: " + e.message;
      }
    }
  }
  out["aac 44.1k mono"] = (await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: RATE, numberOfChannels: 1, bitrate: 128000 })).supported;
  return out;
}

(async () => {
  const report = {};
  try {
    report.support = await support();
    const runs = [
      { label: "9x16-60s-no-preference", W: 1080, H: 1920, seconds: 60, hw: "no-preference" },
      { label: "9x16-60s-software", W: 1080, H: 1920, seconds: 60, hw: "prefer-software" },
      { label: "9x16-60s-hardware", W: 1080, H: 1920, seconds: 60, hw: "prefer-hardware" },
      { label: "1x1-30s-no-preference", W: 1080, H: 1080, seconds: 30, hw: "no-preference" },
      { label: "16x9-30s-no-preference", W: 1920, H: 1080, seconds: 30, hw: "no-preference" },
    ];
    report.renders = {};
    for (const r of runs) {
      try {
        report.renders[r.label] = await render(r);
      } catch (e) {
        report.renders[r.label] = { error: String(e.stack || e).split("\n").slice(0, 3).join(" | ") };
      }
      console.log(r.label, JSON.stringify(report.renders[r.label]));
    }
  } catch (e) {
    report.error = String(e.stack || e);
  }
  ipcRenderer.send("done", report);
})();
