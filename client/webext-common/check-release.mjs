// Release zip check (owner ruling: no test hooks in any public release build).
// build.mjs runs it on both zips after a release build; CI may run it on its own:
//   node check-release.mjs <pusharmor-chrome.zip|pusharmor-firefox.zip>...
// Fails when a zip holds a source map or a test/ entry, when the Chrome manifest has a
// "key", or when the manifest, a .js or a .html holds a public.json placeholder
// ("PLACEHOLDER_..." or "placeholder-..."), a CI dummy (unless PA_CI_DUMMY=1), or a
// local endpoint ("://localhost" or "127.0.0.1"). The bare word "localhost" is allowed:
// the auto-open host rule names it to reject it.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

/** Map of entry name to contents, from the zip central directory (stored or deflate). */
export function readZip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("latin1", p + 46, p + 46 + nameLen);
    const data = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(data, data + size);
    if (method !== 0 && method !== 8) throw new Error(name + ": unsupported zip method " + method);
    out.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Problems found in one release zip; chrome selects the Chrome manifest rule. */
export function checkZip(buf, { chrome, dummyOk = process.env.PA_CI_DUMMY === "1" }) {
  const bad = [];
  const files = readZip(buf);
  for (const name of files.keys()) {
    if (name.endsWith(".map")) bad.push(name + ": source map");
    if (/(^|\/)tests?\//.test(name)) bad.push(name + ": test entry");
  }
  const manifest = files.get("manifest.json");
  if (!manifest) bad.push("manifest.json missing");
  else if (chrome && "key" in JSON.parse(manifest.toString("utf8"))) bad.push("manifest.json: has a \"key\" (dev builds only)");
  for (const [name, data] of files) {
    if (!/\.(js|html|json)$/.test(name)) continue;
    const s = data.toString("latin1");
    if (/placeholder[_-]/i.test(s)) bad.push(name + ": holds a PLACEHOLDER value");
    if (!dummyOk && /ci-fork-dummy/i.test(s)) bad.push(name + ": holds a CI dummy (allowed only with PA_CI_DUMMY=1)");
    if (/:\/\/localhost|127\.0\.0\.1/i.test(s)) bad.push(name + ": names a local endpoint");
  }
  return bad;
}

/** Checks each zip; returns every problem prefixed with the zip name. */
export function checkZips(paths) {
  const bad = [];
  for (const p of paths) {
    for (const b of checkZip(readFileSync(p), { chrome: basename(p).includes("chrome") })) bad.push(basename(p) + ": " + b);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (!paths.length) {
    console.error("usage: node check-release.mjs <zip>...");
    process.exit(2);
  }
  const bad = checkZips(paths);
  if (bad.length) {
    console.error("release zip check failed:\n" + bad.map((b) => "  - " + b).join("\n"));
    process.exit(1);
  }
  console.log("release zip check ok");
}
