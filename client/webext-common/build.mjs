// Builds both extensions: esbuild bundles to unminified ES modules, then
// writes reproducible zips (sorted entries, fixed timestamps).
//   node build.mjs          release build (no Chrome "key"); needs real ids in release/public.json
//                           also writes the Beta zips pusharmor-<browser>-beta.zip: the
//                           same files, name "PushArmor Beta"; Firefox with the Beta
//                           gecko id and update_url (release/constants.json)
//   node build.mjs --dev    dev build (Chrome "key" from release/public.json when set)
//   --public FILE           read FILE instead of release/public.json
//   --dev --shots           also bundles src/shots (store screenshots, shots.mjs) into the
//                           Chrome dev build; refused without --dev
// Build ids (VAPID public key, add-on id, Chrome dev key) come from the tracked
// release/public.json; a release build fails while one holds a placeholder (or a
// CI dummy without PA_CI_DUMMY=1). A release build then checks all four zips
// (check-release.mjs) and fails on a key, placeholder, test entry or local endpoint.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { PUBLIC_PATH, isUnset, loadPublic, publicProblems } from "../../release/public.mjs";
import { checkZips } from "./check-release.mjs";

const here = dirname(new URL(import.meta.url).pathname);
const client = join(here, "..");
const dev = process.argv.includes("--dev");
const shots = process.argv.includes("--shots");
if (shots && !dev) {
  console.error("--shots needs --dev: the screenshot page never goes into a release build");
  process.exit(1);
}
const pi = process.argv.indexOf("--public");
const pub = loadPublic(pi > 0 ? process.argv[pi + 1] : PUBLIC_PATH);
if (!dev) {
  const bad = publicProblems(["webpush_vapid_public_key", "mozilla_firefox_addon_id", "mozilla_firefox_beta_addon_id"], pub);
  if (pub.mozilla_firefox_beta_addon_id === pub.mozilla_firefox_addon_id) bad.push("release/public.json: mozilla_firefox_beta_addon_id equals mozilla_firefox_addon_id");
  // The chrome/v release job uploads to the Beta item only: it must never be the public item.
  const cb = pub.google_chrome_beta_extension_id;
  if (typeof cb === "string" && cb === pub.google_chrome_extension_id) bad.push("release/public.json: google_chrome_beta_extension_id equals google_chrome_extension_id");
  if (typeof cb === "string" && !/placeholder|ci-fork-dummy/i.test(cb) && !/^[a-p]{32}$/.test(cb)) bad.push("release/public.json: google_chrome_beta_extension_id is not 32 letters a-p");
  if (bad.length) {
    console.error("release build failed (dev builds: --dev):");
    for (const b of bad) console.error("  - " + b);
    process.exit(1);
  }
}
// A dev build takes a value only when it is set and not a placeholder.
const value = (k) => {
  const v = pub[k];
  return typeof v === "string" && v !== "" && !isUnset(v) ? v : undefined;
};

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
    define: { VAPID_PUBLIC_KEY: JSON.stringify(value("webpush_vapid_public_key") ?? "") },
    logLevel: "warning",
  };
  await build({ ...common, entryPoints: entries.map((e) => join(root, "src", e + ".ts")), outdir: out, format: "esm" });
  for (const [outName, src] of iife) await build({ ...common, entryPoints: { [outName]: join(root, "src", src + ".ts") }, outdir: out, format: "iife" });
  if (shots && name === "chrome") {
    await build({ ...common, entryPoints: { shots: join(here, "src", "shots", "shots.ts") }, outdir: out, format: "esm" });
    writeFileSync(join(out, "shots.html"), readFileSync(join(here, "src", "shots", "shots.html")));
  }
  const ui = join(here, "src", "ui");
  for (const f of ["popup.html", "page.html", "style.css"]) writeFileSync(join(out, f), readFileSync(join(ui, f)));
  writeFileSync(join(out, "tokens.css"), readFileSync(join(ui, "tokens-" + name + ".css")));
  cpSync(join(here, "icons"), join(out, "icons"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  manifestFix(manifest, out, root);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  zip(out, join(root, "dist", "pusharmor-" + name + (dev ? "-dev" : "") + ".zip"));
  console.log("built", name, dev ? "(dev)" : "");
}

await shell("chrome", ["sw", "popup", "page"], [], "chrome121", (m) => {
  if (dev && value("google_chrome_dev_key")) m.key = value("google_chrome_dev_key");
});
await shell("firefox", ["background", "popup", "page"], [["cs", "sitefwd/cs"]], "firefox140", (m, out, root) => {
  if (value("mozilla_firefox_addon_id")) m.browser_specific_settings.gecko.id = value("mozilla_firefox_addon_id");
  writeFileSync(join(out, "background.html"), readFileSync(join(root, "background.html")));
});
// Beta: a copy of the release files with a Beta manifest (owner ruling Q209 B).
function beta(name, manifestFix) {
  const dist = join(client, name, "dist");
  const out = join(dist, "beta", "unpacked");
  cpSync(join(dist, "unpacked"), out, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  manifest.name = "PushArmor Beta";
  manifestFix(manifest);
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  zip(out, join(dist, "pusharmor-" + name + "-beta.zip"));
  console.log("built", name, "(beta)");
}
if (!dev) {
  const constants = JSON.parse(readFileSync(join(here, "..", "..", "release", "constants.json"), "utf8"));
  beta("chrome", () => {});
  beta("firefox", (m) => {
    m.browser_specific_settings.gecko.id = pub.mozilla_firefox_beta_addon_id;
    m.browser_specific_settings.gecko.update_url = constants.firefox_beta_update_url;
  });
  const zips = ["chrome", "firefox"].flatMap((n) => ["", "-beta"].map((b) => join(client, n, "dist", "pusharmor-" + n + b + ".zip")));
  const bad = checkZips(zips);
  if (bad.length) {
    console.error("release zip check failed:");
    for (const b of bad) console.error("  - " + b);
    process.exit(1);
  }
  console.log("release zip check ok");
}
