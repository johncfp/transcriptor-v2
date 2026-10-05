import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Production builds get a strict CSP. Dev skips it because Vite's hot reload
// needs inline scripts and a websocket.
const csp: Plugin = {
  name: "transcriptor-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src t2-media:; connect-src 'none'; object-src 'none'; base-uri 'none'" />`,
    ),
};

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), csp],
  server: { port: 5183, strictPort: true },
  build: {
    outDir: resolve(__dirname, "out/renderer"),
    emptyOutDir: true,
    // The clip cutter page carries mediabunny (~560 kB); it loads only in that hidden page.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      // The app, and the hidden page that cuts social clips (src/main/clipCutter.ts).
      input: {
        index: resolve(__dirname, "src/renderer/index.html"),
        cutter: resolve(__dirname, "src/renderer/cutter.html"),
      },
    },
  },
});
