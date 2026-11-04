// Release zip check (owner ruling: no test hooks in any public release build).
// build.mjs runs it on both zips after a release build; CI may run it on its own:
//   node check-release.mjs <pusharmor-chrome.zip|pusharmor-firefox.zip>...
// Fails when a zip holds a source map or a test/ entry, when the Chrome manifest has a
// "key" (a Chrome *-unpacked.zip, the GitHub release copy for "Load unpacked", must
// instead have the key google_chrome_dev_key of release/public.json, and differ from
// the store zip beside it only by that key), when the manifest name is not "PushArmor" ("PushArmor Beta" for a *-beta.zip),
// when a Firefox manifest has a gecko update_url other than the Beta one
// (release/constants.json; only *-beta.zip has it) or a gecko id that is not a
// lowercase GUID in braces, or when the manifest, a .js or a .html holds a public.json placeholder
// ("PLACEHOLDER_...", "placeholder-..." or the placeholder gecko id), a CI dummy (unless PA_CI_DUMMY=1), or a
// local endpoint ("://localhost" or "127.0.0.1"), or the screenshot mode marker
// "PA_SCREENSHOTS" (src/shots, dev builds only). The bare word "localhost" is allowed:
// the auto-open host rule names it to reject it.
// Structural checks against the pinned allow-list release-allow.json: every zip entry must
// be in its browser's "entries" list, every runtime message op the shipped JS dispatches on
// (case labels of a switch on X.op, and X.op compared to a literal) must be in "ops" (a test
// pins "ops" to the handlers in the source), and no shipped JS may touch globalThis.__*.
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inflateRawSync } from "node:zlib";
import { GECKO_ID_RE, GECKO_PLACEHOLDER_ID, isDummy, loadPublic } from "../../release/public.mjs";

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

/** Problems found in one release zip; chrome selects the Chrome manifest rule, beta the Beta name,
 *  key the manifest "key" a Chrome *-unpacked.zip must have (undefined: no key allowed). */
export function checkZip(buf, { chrome, beta = false, key, dummyOk = process.env.PA_CI_DUMMY === "1", allow = ALLOW }) {
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
    if (chrome && key === undefined && "key" in m) bad.push("manifest.json: has a \"key\" (dev builds and the -unpacked.zip only)");
    if (chrome && key !== undefined && m.key !== key) bad.push("manifest.json: \"key\" is not google_chrome_dev_key of release/public.json");
    const name = beta ? "PushArmor Beta" : "PushArmor";
    if (m.name !== name) bad.push("manifest.json: name is " + JSON.stringify(m.name) + ", want " + JSON.stringify(name));
    const update = m.browser_specific_settings?.gecko?.update_url;
    if (!chrome && update !== (beta ? BETA_UPDATE_URL : undefined)) bad.push("manifest.json: gecko update_url is " + JSON.stringify(update ?? null));
    const id = m.browser_specific_settings?.gecko?.id;
    if (!chrome && id !== undefined && !GECKO_ID_RE.test(id)) bad.push("manifest.json: gecko id " + JSON.stringify(id) + " is not a lowercase GUID");
  }
  for (const [name, data] of files) {
    if (!/\.(js|html|json)$/.test(name)) continue;
    const s = data.toString("latin1");
    if (/placeholder[_-]/i.test(s) || s.includes(GECKO_PLACEHOLDER_ID)) bad.push(name + ": holds a PLACEHOLDER value");
    if (!dummyOk && isDummy(s)) bad.push(name + ": holds a CI dummy (allowed only with PA_CI_DUMMY=1)");
    if (/:\/\/localhost|127\.0\.0\.1/i.test(s)) bad.push(name + ": names a local endpoint");
    if (s.includes("PA_SCREENSHOTS")) bad.push(name + ": holds the screenshot mode (src/shots)");
    if (!name.endsWith(".js")) continue;
    if (/globalThis\s*(\.\s*__|\[\s*["'`]__)/.test(s)) bad.push(name + ": sets or reads globalThis.__*");
    for (const op of ops(s)) if (!allowedOps.has(op)) bad.push(name + ": message op \"" + op + "\" not in release-allow.json");
  }
  return bad;
}

/** Problems of a keyed zip against its store zip: the same entries and bytes, except a
 *  manifest.json that is the store manifest plus "key". */
export function keyedDiff(storeBuf, keyedBuf) {
  const bad = [];
  const a = readZip(storeBuf);
  const b = readZip(keyedBuf);
  for (const n of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(n) || !b.has(n)) bad.push(n + ": only in " + (a.has(n) ? "the store zip" : "the -unpacked.zip"));
    else if (n !== "manifest.json" && !a.get(n).equals(b.get(n))) bad.push(n + ": differs from the store zip");
  }
  if (a.has("manifest.json") && b.has("manifest.json")) {
    const { key, ...rest } = JSON.parse(b.get("manifest.json").toString("utf8"));
    if (!isDeepStrictEqual(rest, JSON.parse(a.get("manifest.json").toString("utf8")))) bad.push("manifest.json: differs from the store zip by more than \"key\"");
  }
  return bad;
}

/** Checks each zip; returns every problem prefixed with the zip name. A Chrome
 *  *-unpacked.zip is also compared with the store zip beside it (name without -unpacked). */
export function checkZips(paths, key = loadPublic().google_chrome_dev_key) {
  const bad = [];
  for (const p of paths) {
    const n = basename(p);
    const chrome = n.includes("chrome");
    const keyed = chrome && n.endsWith("-unpacked.zip");
    for (const b of checkZip(readFileSync(p), { chrome, beta: n.includes("-beta"), key: keyed ? key ?? "" : undefined })) bad.push(n + ": " + b);
    if (!keyed) continue;
    const store = p.slice(0, -"-unpacked.zip".length) + ".zip";
    if (!existsSync(store)) bad.push(n + ": no store zip " + basename(store) + " beside it");
    else for (const b of keyedDiff(readFileSync(store), readFileSync(p))) bad.push(n + ": " + b);
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
