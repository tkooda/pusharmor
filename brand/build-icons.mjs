// Writes every app and site icon from the brand SVGs in this directory.
//   node brand/build-icons.mjs
// The outputs are committed, so no app or site build runs this script.
// It renders with sharp (librsvg), taken from site/node_modules: run
// "npm ci" in site/ first. Run it again after a change to a brand SVG.
//
// Large icon (128 px and up): pusharmor-icon-large.svg. Small icon (48 px
// and below): pusharmor-icon-small.svg. The Android vectors use the shield
// and arrow path data of the small SVG; the arrow is an even-odd hole.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const sharp = createRequire(join(root, "site", "package.json"))("sharp");

const NAVY = "#1F3A5F";
const large = readFileSync(join(here, "pusharmor-icon-large.svg"));
const small = readFileSync(join(here, "pusharmor-icon-small.svg"));

const out = (rel, data) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log("wrote", rel);
};
// Renders at 4x, then scales down, so small sizes stay sharp and even.
const render = (svg, size) => sharp(svg, { density: (72 * size * 4) / 512 }).resize(size, size, { kernel: "lanczos3" });
const png = (svg, size) => render(svg, size).png({ compressionLevel: 9 }).toBuffer();
// Full-bleed square with no alpha channel: the corners of the rounded tile are
// filled with the tile color (iOS app icon, apple-touch-icon).
const opaque = (svg, size) => render(svg, size).flatten({ background: NAVY }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();

// ICO with PNG entries.
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head[e] = size % 256;
    head[e + 1] = size % 256;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map(([, d]) => d)]);
}

// Android vector: the shield with the arrow hole, scaled about the shield
// center (256, 257) and moved to the center of the viewport.
const svgText = small.toString("utf8");
const shieldPath = /<path fill="#34C77B"[^>]* d="([^"]+)"/.exec(svgText)[1];
const arrowPath = /<path fill="#000" d="([^"]+)"/.exec(svgText)[1];
function vector(dp, scale, color) {
  const c = dp / 2;
  const n = (v) => String(Number(v.toFixed(4)));
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by brand/build-icons.mjs from brand/pusharmor-icon-small.svg. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${dp}dp" android:height="${dp}dp" android:viewportWidth="${dp}" android:viewportHeight="${dp}">
    <group android:pivotX="256" android:pivotY="257" android:scaleX="${n(scale)}" android:scaleY="${n(scale)}"
        android:translateX="${n(c - 256)}" android:translateY="${n(c - 257)}">
        <path android:fillColor="${color}" android:fillType="evenOdd"
            android:pathData="${shieldPath} ${arrowPath}" />
    </group>
</vector>
`;
}

// Chrome and Firefox
for (const s of [16, 32, 48]) out(`client/webext-common/icons/icon-${s}.png`, await png(small, s));
out("client/webext-common/icons/icon-128.png", await png(large, 128));

// Android. Adaptive foreground: 108 dp; the shield (farthest point 161 units
// from its center) at scale 0.2 stays inside the 66 dp safe circle.
const res = "client/android/app/src/main/res/";
out(res + "drawable/ic_launcher_foreground.xml", vector(108, 0.2, "#FF34C77B"));
// Notification small icon: white on transparent, the shield 22 dp tall in 24 dp.
out(res + "drawable/ic_notify.xml", vector(24, 22 / 298, "#FFFFFFFF"));

// iOS: one 1024 px universal app icon.
out("client/ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png", await opaque(large, 1024));

// Site
out("site/public/favicon.ico", ico([[16, await png(small, 16)], [32, await png(small, 32)], [48, await png(small, 48)]]));
out("site/public/apple-touch-icon.png", await opaque(large, 180));
