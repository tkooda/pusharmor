// Store screenshot check (workflow screenshots.yml):
//   node release/check-screenshots.mjs <android|ios|chrome|firefox> <dir> [--flatten]
// Every file in <dir> must be an 8-bit PNG named NN-name.png (ASCII: two digits, a dash,
// then a-z, 0-9 and dashes), RGB with no alpha channel, not one single color, in a size
// and count the store takes:
//   android  2-8 at 1080x1920 (Google Play phone)
//   ios      3-10 at 1320x2868 or 1290x2796 (App Store 6.9" / 6.7" iPhone)
//   chrome   1-5 at 1280x800 (Chrome Web Store)
//   firefox  1-5 at 1280x800 (addons.mozilla.org)
// --flatten first rewrites each RGBA PNG as RGB, composited over white.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

export const RULES = {
  android: { min: 2, max: 8, sizes: [[1080, 1920]] },
  ios: { min: 3, max: 10, sizes: [[1320, 2868], [1290, 2796]] },
  chrome: { min: 1, max: 5, sizes: [[1280, 800]] },
  firefox: { min: 1, max: 5, sizes: [[1280, 800]] },
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NAME = /^[0-9]{2}-[a-z0-9-]+\.png$/;

/** Header and raw pixel rows (filters undone) of an 8-bit RGB or RGBA PNG. */
export function decodePng(buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG file");
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR chunk");
  const h = { width: ihdr.readUInt32BE(0), height: ihdr.readUInt32BE(4), depth: ihdr[8], colorType: ihdr[9], interlace: ihdr[12] };
  if (h.depth !== 8 || (h.colorType !== 2 && h.colorType !== 6) || h.interlace !== 0) {
    return { ...h, pixels: null };
  }
  const bpp = h.colorType === 6 ? 4 : 3;
  const stride = h.width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h.height) throw new Error("image data too short");
  const px = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error("bad PNG filter " + f);
      px[row + x] = v & 255;
    }
  }
  return { ...h, pixels: px };
}

function chunk(type, data) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

/** An 8-bit PNG from raw rows: colorType 2 (RGB) or 6 (RGBA). */
export function encodePng(width, height, pixels, colorType = 2) {
  const stride = width * (colorType === 6 ? 4 : 3);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** RGB copy of an RGBA PNG, composited over white; null when the file has no alpha. */
export function flattenPng(buf) {
  const img = decodePng(buf);
  if (img.colorType !== 6 || !img.pixels) return null;
  const n = img.width * img.height;
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.pixels[i * 4 + 3];
    for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.round((img.pixels[i * 4 + k] * a + 255 * (255 - a)) / 255);
  }
  return encodePng(img.width, img.height, out, 2);
}

/** Problems with the screenshots in dir for platform; an empty list passes. */
export function checkDir(platform, dir) {
  const rule = RULES[platform];
  if (!rule) return ["unknown platform " + JSON.stringify(platform) + " (android, ios, chrome or firefox)"];
  const bad = [];
  const files = readdirSync(dir).sort();
  for (const f of files) {
    if (!NAME.test(f)) {
      bad.push(f + ": name is not NN-name.png (ASCII a-z, 0-9, dashes)");
      continue;
    }
    let img;
    try {
      img = decodePng(readFileSync(join(dir, f)));
    } catch (e) {
      bad.push(f + ": " + e.message);
      continue;
    }
    if (!rule.sizes.some(([w, h]) => img.width === w && img.height === h)) {
      bad.push(f + ": " + img.width + "x" + img.height + ", want " + rule.sizes.map((s) => s.join("x")).join(" or "));
    }
    if (img.colorType !== 2) bad.push(f + ": PNG color type " + img.colorType + ", want 2 (RGB, no alpha)");
    if (img.depth !== 8 || img.interlace !== 0) bad.push(f + ": want 8-bit, not interlaced");
    if (img.pixels && img.colorType === 2) {
      const first = img.pixels.subarray(0, 3);
      let same = true;
      for (let i = 3; i < img.pixels.length && same; i += 3) same = img.pixels[i] === first[0] && img.pixels[i + 1] === first[1] && img.pixels[i + 2] === first[2];
      if (same) bad.push(f + ": the whole image is one color");
    }
  }
  const n = files.filter((f) => NAME.test(f)).length;
  if (n < rule.min || n > rule.max) bad.push(n + " screenshots, want " + rule.min + " to " + rule.max);
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [platform, dir] = process.argv.slice(2).filter((a) => a !== "--flatten");
  if (!platform || !dir) {
    console.error("usage: node release/check-screenshots.mjs <android|ios|chrome|firefox> <dir> [--flatten]");
    process.exit(2);
  }
  if (process.argv.includes("--flatten")) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".png"))) {
      const flat = flattenPng(readFileSync(join(dir, f)));
      if (flat) {
        writeFileSync(join(dir, f), flat);
        console.log("flattened " + f);
      }
    }
  }
  const bad = checkDir(platform, dir);
  if (bad.length) {
    console.error("screenshot check failed (" + platform + "):\n" + bad.map((b) => "  - " + b).join("\n"));
    process.exit(1);
  }
  console.log("screenshot check ok (" + platform + "): " + readdirSync(dir).join(" "));
}
