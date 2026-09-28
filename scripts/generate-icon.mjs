// Rasterize assets/icon.svg into the app icons, all from one source:
//   build/icon.png (1024, also used for the tray) + build/icon.ico (Windows) + build/icon.icns (macOS)
// Run: npm run icon
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import png2icons from "png2icons";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets", "icon.svg"));

const png1024 = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(join(root, "build", "icon.png"), png1024);
writeFileSync(join(root, "build", "icon.ico"), png2icons.createICO(png1024, png2icons.BICUBIC, 0, false));
writeFileSync(join(root, "build", "icon.icns"), png2icons.createICNS(png1024, png2icons.BICUBIC, 0));

console.log("Wrote build/icon.{png,ico,icns}");
