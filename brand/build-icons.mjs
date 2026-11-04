// Writes every app and site icon from the brand SVGs in this directory.
//   node brand/build-icons.mjs
// The outputs are committed, so no app or site build runs this script.
// It renders with sharp (librsvg), taken from site/node_modules: run
// "npm ci" in site/ first. Run it again after a change to a brand SVG.
//
// pusharmor-mark.svg: the mark on a clear background (32 px and up).
// pusharmor-mark-16.svg: the same mark drawn pixel by pixel for 16 px.
// pusharmor-app-icon.svg: the mark on a full-bleed ink square (app icons).
// The Android vectors use the shield and arrow path data of pusharmor-mark.svg.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const root = join(here, "..");
const sharp = createRequire(join(root, "site", "package.json"))("sharp");

const GREEN = "#15A86B";
const INK = "#06351F";
const mark = readFileSync(join(here, "pusharmor-mark.svg"));
const mark16 = readFileSync(join(here, "pusharmor-mark-16.svg"));
const appIcon = readFileSync(join(here, "pusharmor-app-icon.svg"));

const out = (rel, data) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  console.log("wrote", rel);
};
// Renders at 4x, then scales down, so small sizes stay sharp and even.
const render = (svg, size) => sharp(svg, { density: (72 * size * 4) / 512 }).resize(size, size, { kernel: "lanczos3" });
const png = (svg, size) => render(svg, size).png({ compressionLevel: 9 }).toBuffer();
// The 16 px mark is pixel art: render it 1:1.
const png16 = () => sharp(mark16, { density: 72 }).png({ compressionLevel: 9 }).toBuffer();
// Full-bleed square with no alpha channel (iOS app icon, apple-touch-icon, store icon).
const opaque = (size) => render(appIcon, size).flatten({ background: INK }).removeAlpha().png({ compressionLevel: 9 }).toBuffer();

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

// Android vectors, scaled about the shield center (256, 257) and moved to the
// center of the viewport.
const markText = mark.toString("utf8");
const [shieldPath, arrowPath] = [...markText.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
const n = (v) => String(Number(v.toFixed(5)));
function vector(dp, scale, paths) {
  const c = dp / 2;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by brand/build-icons.mjs from brand/pusharmor-mark.svg. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${dp}dp" android:height="${dp}dp" android:viewportWidth="${dp}" android:viewportHeight="${dp}">
    <group android:pivotX="256" android:pivotY="257" android:scaleX="${n(scale)}" android:scaleY="${n(scale)}"
        android:translateX="${n(c - 256)}" android:translateY="${n(c - 257)}">
${paths}
    </group>
</vector>
`;
}
const argb = (hex) => "#FF" + hex.slice(1);
// Full color: green shield and white arrow, each with an ink edge.
const color = `        <path android:fillColor="${argb(GREEN)}" android:strokeColor="${argb(INK)}" android:strokeWidth="10"
            android:strokeLineJoin="round" android:pathData="${shieldPath}" />
        <path android:fillColor="#FFFFFFFF" android:strokeColor="${argb(INK)}" android:strokeWidth="12"
            android:pathData="${arrowPath}" />`;
// One color: the shield with the arrow as an even-odd hole.
const solid = (c) => `        <path android:fillColor="${c}" android:fillType="evenOdd"
            android:pathData="${shieldPath} ${arrowPath}" />`;

// Chrome and Firefox
out("client/webext-common/icons/icon-16.png", await png16());
for (const s of [32, 48, 128]) out(`client/webext-common/icons/icon-${s}.png`, await png(mark, s));

// Android. Adaptive layers are 108 dp (512 units). The mark is scaled 0.94 like
// the app icon tile design, so its farthest point (about 166 units from the
// center, edge included) stays inside the 66 dp safe circle.
const res = "client/android/app/src/main/res/";
const fg = (0.94 * 108) / 512;
out(res + "drawable/ic_launcher_foreground.xml", vector(108, fg, color));
out(res + "drawable/ic_launcher_monochrome.xml", vector(108, fg, solid("#FFFFFFFF")));
// Notification small icon: white on transparent, the shield 22 dp tall in 24 dp.
out(res + "drawable/ic_notify.xml", vector(24, 22 / 298, solid("#FFFFFFFF")));

// iOS: one 1024 px universal app icon.
out("client/ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png", await opaque(1024));

// Store icon (F-Droid; the same file serves the Play listing).
out("release/fdroid/metadata/com.pusharmor/en-US/icon.png", await opaque(512));

// Site
out("site/public/favicon.ico", ico([[16, await png16()], [32, await png(mark, 32)], [48, await png(mark, 48)]]));
out("site/public/apple-touch-icon.png", await opaque(180));
