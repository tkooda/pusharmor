// Builds both extensions: esbuild bundles to unminified ES modules, then
// writes reproducible zips (sorted entries, fixed timestamps).
//   node build.mjs          release build (no Chrome "key")
//   node build.mjs --dev    dev build (Chrome "key" from release/constants.json)
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { deflateRawSync, deflateSync, crc32 } from "node:zlib";

const here = dirname(new URL(import.meta.url).pathname);
const client = join(here, "..");
const constants = JSON.parse(readFileSync(join(client, "..", "release", "constants.json"), "utf8"));
const dev = process.argv.includes("--dev");

function icon(size) {
  // solid square PNG, generated so no binary sits in the repo
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) {
    const edge = x < size / 8 || x >= size - size / 8;
    row.writeUInt32BE(edge ? 0x1f3a5fff : 0x2f6fbfff, 1 + x * 4);
  }
  const raw = Buffer.concat(Array.from({ length: size }, (_, y) => {
    if (y < size / 8 || y >= size - size / 8) {
      const r = Buffer.alloc(1 + size * 4);
      for (let x = 0; x < size; x++) r.writeUInt32BE(0x1f3a5fff, 1 + x * 4);
      return r;
    }
    return row;
  }));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Zip with sorted entries, DOS time 1980-01-01 00:00, deflate. */
function zip(dir, outFile) {
  const files = walk(dir).map((p) => relative(dir, p).split("\\").join("/")).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of files) {
    const data = readFileSync(join(dir, name));
    const comp = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "ascii");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
}

async function shell(name, entries, iife, target, manifestFix) {
  const root = join(client, name);
  const out = join(root, "dist", "unpacked");
  rmSync(join(root, "dist"), { recursive: true, force: true });
  mkdirSync(join(out, "icons"), { recursive: true });
  const common = {
    bundle: true,
    minify: false,
    sourcemap: false,
    legalComments: "inline",
    charset: "ascii",
    target,
    define: { VAPID_PUBLIC_KEY: JSON.stringify(constants.vapid_public_key) },
    logLevel: "warning",
  };
  await build({ ...common, entryPoints: entries.map((e) => join(root, "src", e + ".ts")), outdir: out, format: "esm" });
  for (const [outName, src] of iife) await build({ ...common, entryPoints: { [outName]: join(root, "src", src + ".ts") }, outdir: out, format: "iife" });
  const ui = join(here, "src", "ui");
  for (const f of ["popup.html", "page.html", "style.css"]) writeFileSync(join(out, f), readFileSync(join(ui, f)));
  writeFileSync(join(out, "icons", "icon-128.png"), icon(128));
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  manifestFix(manifest, out, root);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  zip(out, join(root, "dist", "pusharmor-" + name + (dev ? "-dev" : "") + ".zip"));
  console.log("built", name, dev ? "(dev)" : "");
}

await shell("chrome", ["sw", "popup", "page"], [], "chrome121", (m) => {
  if (dev) m.key = constants.chrome_dev_key;
});
await shell("firefox", ["background", "popup", "page"], [["cs", "sitefwd/cs"]], "firefox140", (_m, out, root) => {
  writeFileSync(join(out, "background.html"), readFileSync(join(root, "background.html")));
});
