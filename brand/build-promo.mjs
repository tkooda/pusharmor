// Writes the Chrome Web Store and Google Play listing images into store/promo/.
//   node brand/build-promo.mjs
// Needs sharp from site/node_modules (run "npm ci" in site/ first).
// The promo images are flat ink with no alpha channel; the store icon is clear-cornered.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const sharp = createRequire(join(root, "site", "package.json"))("sharp");
const dir = join(root, "store", "promo");
mkdirSync(dir, { recursive: true });

const INK = "#06351F";
const FONT = "'Inter', 'Helvetica Neue', Arial, sans-serif";
const TAG = ["Send URLs and text between", "your own devices"];
const shield = readFileSync(join(here, "pusharmor-mark.svg"), "utf8").match(/<path[\s\S]*<\/path>|<path[^>]*\/>/g).join("");

// Store icon: the app icon artwork as a 96 px rounded square inside 128 px of clear padding.
const appIcon = readFileSync(join(here, "pusharmor-app-icon.svg"), "utf8")
  .replace('<rect width="512" height="512" fill="#06351F"/>', '<rect width="512" height="512" rx="108" fill="#06351F"/>');
const icon96 = await sharp(Buffer.from(appIcon), { density: 72 * 4 * 96 / 512 }).resize(96, 96, { kernel: "lanczos3" }).png().toBuffer();
await sharp({ create: { width: 128, height: 128, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: icon96, left: 16, top: 16 }]).png({ compressionLevel: 9 }).toFile(join(dir, "cws-icon-128.png"));
console.log("wrote store/promo/cws-icon-128.png");

// Promo: mark on the left, wordmark and tagline on the right, the group centered.
// m = mark size, w = wordmark font size, t = tagline font size.
function promo(name, W, H, m, w, t) {
  const gap = m * 0.28;
  const wordW = w * 5.45;
  const tagW = t * 0.54 * Math.max(...TAG.map((s) => s.length));
  const textW = Math.max(wordW, tagW);
  const x0 = (W - (m + gap + textW)) / 2;
  const tx = x0 + m + gap;
  const lh = t * 1.3;
  const blockH = w * 0.75 + t * 0.9 + w * 0.3 + (TAG.length - 1) * lh; // cap height + gap + tagline
  const top = (H - blockH) / 2;
  const base = top + w * 0.75;
  const tag = TAG.map((s, i) => `<text x="${tx}" y="${base + w * 0.3 + t * 0.9 + i * lh}" font-family="${FONT}" font-size="${t}" fill="#F3F6FA" fill-opacity="0.82">${s}</text>`).join("");
  const s = m / 324;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${INK}"/>
<g transform="translate(${x0} ${(H - m) / 2}) scale(${s}) translate(-94 -95)">${shield}</g>
<text x="${tx}" y="${base}" font-family="${FONT}" font-size="${w}" font-weight="700" letter-spacing="${-w * 0.018}"><tspan fill="#15A86B">Push</tspan><tspan fill="#F3F6FA">Armor</tspan></text>
${tag}</svg>`;
  writeFileSync(join(dir, name.replace(".png", ".svg")), svg);
  return sharp(Buffer.from(svg), { density: 72 * 2 }).resize(W, H, { kernel: "lanczos3" })
    .flatten({ background: INK }).removeAlpha().png({ compressionLevel: 9 }).toFile(join(dir, name))
    .then(() => console.log("wrote store/promo/" + name));
}
await promo("cws-small-440x280.png", 440, 280, 96, 44, 17);
await promo("cws-marquee-1400x560.png", 1400, 560, 300, 124, 44);
await promo("play-feature-1024x500.png", 1024, 500, 240, 100, 36);
