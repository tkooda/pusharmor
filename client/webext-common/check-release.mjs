// Release zip check (owner ruling: no test hooks in any public release build).
// build.mjs runs it on both zips after a release build; CI may run it on its own:
//   node check-release.mjs <pusharmor-chrome.zip|pusharmor-firefox.zip>...
// Fails when a zip holds a source map or a test/ entry, when the Chrome manifest has a
// "key", when the manifest name is not "PushArmor" ("PushArmor Beta" for a *-beta.zip),
// when a Firefox manifest has a gecko update_url other than the Beta one
// (release/constants.json; only *-beta.zip has it), or when the manifest, a .js or a .html holds a public.json placeholder
// ("PLACEHOLDER_..." or "placeholder-..."), a CI dummy (unless PA_CI_DUMMY=1), or a
// local endpoint ("://localhost" or "127.0.0.1"). The bare word "localhost" is allowed:
// the auto-open host rule names it to reject it.
// Structural checks against the pinned allow-list release-allow.json: every zip entry must
// be in its browser's "entries" list, every runtime message op the shipped JS dispatches on
// (case labels of a switch on X.op, and X.op compared to a literal) must be in "ops" (a test
// pins "ops" to the handlers in the source), and no shipped JS may touch globalThis.__*.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

export const ALLOW = JSON.parse(readFileSync(new URL("./release-allow.json", import.meta.url), "utf8"));
const BETA_UPDATE_URL = JSON.parse(readFileSync(new URL("../../release/constants.json", import.meta.url), "utf8")).firefox_beta_update_url;

/** Op names a runtime message handler in the text dispatches on. */
export function ops(text) {
  const out = new Set();
  for (const m of text.matchAll(/switch\s*\(\s*[\w$]+\.op\s*\)\s*\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    for (const c of text.slice(m.index, i).matchAll(/case\s+["'`]([^"'`]*)["'`]\s*:/g)) out.add(c[1]);
  }
  for (const m of text.matchAll(/(typeof\s+)?[\w$]+\.op\s*[!=]==?\s*["'`]([^"'`]*)["'`]/g)) if (!m[1]) out.add(m[2]);
  return [...out];
}

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

/** Problems found in one release zip; chrome selects the Chrome manifest rule, beta the Beta name. */
export function checkZip(buf, { chrome, beta = false, dummyOk = process.env.PA_CI_DUMMY === "1", allow = ALLOW }) {
  const bad = [];
  const files = readZip(buf);
  const entries = new Set(allow.entries[chrome ? "chrome" : "firefox"]);
  const allowedOps = new Set(allow.ops);
  for (const name of files.keys()) {
    if (!entries.has(name)) bad.push(name + ": entry not in release-allow.json");
    if (name.endsWith(".map")) bad.push(name + ": source map");
    if (/(^|\/)tests?\//.test(name)) bad.push(name + ": test entry");
  }
  const manifest = files.get("manifest.json");
  if (!manifest) bad.push("manifest.json missing");
  else {
    const m = JSON.parse(manifest.toString("utf8"));
    if (chrome && "key" in m) bad.push("manifest.json: has a \"key\" (dev builds only)");
    const name = beta ? "PushArmor Beta" : "PushArmor";
    if (m.name !== name) bad.push("manifest.json: name is " + JSON.stringify(m.name) + ", want " + JSON.stringify(name));
    const update = m.browser_specific_settings?.gecko?.update_url;
    if (!chrome && update !== (beta ? BETA_UPDATE_URL : undefined)) bad.push("manifest.json: gecko update_url is " + JSON.stringify(update ?? null));
  }
  for (const [name, data] of files) {
    if (!/\.(js|html|json)$/.test(name)) continue;
    const s = data.toString("latin1");
    if (/placeholder[_-]/i.test(s)) bad.push(name + ": holds a PLACEHOLDER value");
    if (!dummyOk && /ci-fork-dummy/i.test(s)) bad.push(name + ": holds a CI dummy (allowed only with PA_CI_DUMMY=1)");
    if (/:\/\/localhost|127\.0\.0\.1/i.test(s)) bad.push(name + ": names a local endpoint");
    if (!name.endsWith(".js")) continue;
    if (/globalThis\s*(\.\s*__|\[\s*["'`]__)/.test(s)) bad.push(name + ": sets or reads globalThis.__*");
    for (const op of ops(s)) if (!allowedOps.has(op)) bad.push(name + ": message op \"" + op + "\" not in release-allow.json");
  }
  return bad;
}

/** Checks each zip; returns every problem prefixed with the zip name. */
export function checkZips(paths) {
  const bad = [];
  for (const p of paths) {
    const n = basename(p);
    for (const b of checkZip(readFileSync(p), { chrome: n.includes("chrome"), beta: n.includes("-beta") })) bad.push(n + ": " + b);
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
