// release/check-screenshots.mjs. Run: node --test release/check-screenshots.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { checkDir, decodePng, encodePng, flattenPng } from "./check-screenshots.mjs";

const SCRIPT = join(import.meta.dirname, "check-screenshots.mjs");

/** A w x h PNG with a two-color pattern (RGB, or RGBA with the given alpha). */
function png(w, h, { alpha = null } = {}) {
  const bpp = alpha === null ? 3 : 4;
  const px = Buffer.alloc(w * h * bpp, 255);
  for (let i = 0; i < w * h; i++) {
    if ((i % w) < w / 2) px.fill(40, i * bpp, i * bpp + 3);
    if (alpha !== null) px[i * bpp + 3] = alpha;
  }
  return encodePng(w, h, px, alpha === null ? 2 : 6);
}

function dir(files) {
  const d = mkdtempSync(join(tmpdir(), "pa-shots-test-"));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(d, name), data);
  return d;
}

function withDir(files, fn) {
  const d = dir(files);
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

const chrome = png(1280, 800);
const android = png(1080, 1920);

test("encode and decode round-trip", () => {
  const img = decodePng(png(6, 3));
  assert.equal(img.width, 6);
  assert.equal(img.colorType, 2);
  assert.deepEqual([...img.pixels.subarray(0, 3)], [40, 40, 40]);
  assert.deepEqual([...img.pixels.subarray(9, 12)], [255, 255, 255]);
});

test("decode undoes PNG filters 1-4 (Sub, Up, Average, Paeth)", () => {
  const w = 5, h = 5, bpp = 3, stride = w * bpp;
  const px = Buffer.alloc(stride * h);
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 255;
  const raw = Buffer.alloc((stride + 1) * h);
  const at = (y, x) => (y < 0 || x < 0 ? 0 : px[y * stride + x]);
  for (let y = 0; y < h; y++) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const a = at(y, x - bpp), b = at(y - 1, x), c = at(y - 1, x - bpp);
      const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + x] = (px[y * stride + x] - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (t, d) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    return Buffer.concat([len, Buffer.from(t), d, Buffer.alloc(4)]);
  };
  const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual(decodePng(file).pixels, px);
});

test("valid sets pass for each platform", () => {
  assert.deepEqual(withDir({ "01-send.png": chrome }, (d) => checkDir("chrome", d)), []);
  assert.deepEqual(withDir({ "01-peers.png": android, "02-send.png": android }, (d) => checkDir("android", d)), []);
  const ios = png(1320, 2868);
  const old = png(1290, 2796);
  assert.deepEqual(withDir({ "01-a.png": ios, "02-b.png": ios, "03-c.png": old }, (d) => checkDir("ios", d)), []);
});

test("counts outside the store range fail", () => {
  assert.match(withDir({ "01-peers.png": android }, (d) => checkDir("android", d)).join(), /1 screenshots, want 2 to 8/);
  const six = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => ["0" + i + "-x.png", chrome]));
  assert.match(withDir(six, (d) => checkDir("chrome", d)).join(), /6 screenshots, want 1 to 5/);
  assert.match(withDir({}, (d) => checkDir("ios", d)).join(), /0 screenshots, want 3 to 10/);
});

test("a wrong size, alpha, a bad name, a non-PNG and a one-color image fail", () => {
  assert.match(withDir({ "01-send.png": png(1280, 801) }, (d) => checkDir("chrome", d)).join(), /1280x801, want 1280x800/);
  assert.match(withDir({ "01-send.png": png(1280, 800, { alpha: 255 }) }, (d) => checkDir("chrome", d)).join(), /color type 6, want 2/);
  assert.match(withDir({ "01-send.png": chrome, "Send.png": chrome }, (d) => checkDir("chrome", d)).join(), /Send\.png: name is not NN-name\.png/);
  assert.match(withDir({ "01-send.png": chrome, "notes.txt": "x" }, (d) => checkDir("chrome", d)).join(), /notes\.txt: name/);
  assert.match(withDir({ "01-send.png": Buffer.from("not a png") }, (d) => checkDir("chrome", d)).join(), /not a PNG file/);
  const flat = encodePng(1280, 800, Buffer.alloc(1280 * 800 * 3, 7));
  assert.match(withDir({ "01-send.png": flat }, (d) => checkDir("chrome", d)).join(), /one color/);
  assert.match(checkDir("web", ".").join(), /unknown platform/);
});

test("flatten turns RGBA into RGB over white; RGB files are left alone", () => {
  const half = decodePng(flattenPng(png(4, 2, { alpha: 0 })));
  assert.equal(half.colorType, 2);
  assert.deepEqual([...half.pixels.subarray(0, 3)], [255, 255, 255]);
  const full = decodePng(flattenPng(png(4, 2, { alpha: 255 })));
  assert.deepEqual([...full.pixels.subarray(0, 3)], [40, 40, 40]);
  assert.equal(flattenPng(png(4, 2)), null);
});

test("CLI: --flatten fixes alpha in place; exit 1 on a failed check, 2 on bad usage", () => {
  withDir({ "01-send.png": png(1280, 800, { alpha: 255 }) }, (d) => {
    assert.equal(spawnSync(process.execPath, [SCRIPT, "chrome", d]).status, 1);
    const r = spawnSync(process.execPath, [SCRIPT, "chrome", d, "--flatten"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decodePng(readFileSync(join(d, "01-send.png"))).colorType, 2);
  });
  assert.equal(spawnSync(process.execPath, [SCRIPT]).status, 2);
});
