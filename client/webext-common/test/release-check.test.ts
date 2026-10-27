import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
// @ts-expect-error plain .mjs module without types
import { checkZip, ops, readZip } from "../check-release.mjs";
import { readFileSync } from "node:fs";

/** Minimal zip writer: even entries deflate, odd entries stored. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text], i) => {
    const data = Buffer.from(text, "utf8");
    const method = i % 2 === 0 ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const nm = Buffer.from(name, "ascii");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nm);
    offset += 30 + nm.length + body.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const GOOD = {
  "manifest.json": JSON.stringify({ manifest_version: 3, name: "PushArmor" }),
  "sw.js": 'if (last === "localhost" || last === "local") return false; fetch("https://api.pusharmor.com/v1/peers");',
  "page.js": 'h("input", { placeholder: "Email address" });',
  "popup.html": '<input placeholder="Code">',
  "icons/icon-128.png": "png",
};
const { "sw.js": swJs, ...SHARED } = GOOD;
const GOOD_FX = { ...SHARED, "background.js": swJs, "cs.js": "", "background.html": "<script src=background.js></script>" };
const check = (files: Record<string, string>, chrome = true, dummyOk = false): string[] => {
  const fx = !chrome && "sw.js" in files ? (({ "sw.js": s, ...r }) => ({ ...r, "background.js": s }))(files) : files;
  return checkZip(zip(chrome ? files : fx), { chrome, dummyOk });
};

test("readZip reads stored and deflated entries", () => {
  const m = readZip(zip({ a: "one", b: "two", c: "three" }));
  assert.deepEqual([...m.keys()], ["a", "b", "c"]);
  assert.equal(m.get("c").toString(), "three");
});

test("a clean release zip passes (bare localhost word and input placeholders allowed)", () => {
  assert.deepEqual(check(GOOD), []);
  assert.deepEqual(check(GOOD, false), []);
  assert.deepEqual(check(GOOD_FX, false), []);
});

test("Chrome manifest key fails; Firefox has no such rule", () => {
  const m = { ...GOOD, "manifest.json": JSON.stringify({ name: "PushArmor", key: "MIIB" }) };
  assert.match(check(m).join(), /has a "key"/);
  assert.deepEqual(check(m, false), []);
});

test("manifest name: PushArmor, or PushArmor Beta in a Beta zip; Firefox update_url only the Beta one", () => {
  const url = JSON.parse(readFileSync(new URL("../../../release/constants.json", import.meta.url), "utf8")).firefox_beta_update_url;
  const fx = (m: object) => ({ ...GOOD_FX, "manifest.json": JSON.stringify(m) });
  const b = (files: Record<string, string>, chrome: boolean) => checkZip(zip(files), { chrome, beta: true, dummyOk: false });
  assert.deepEqual(b({ ...GOOD, "manifest.json": JSON.stringify({ name: "PushArmor Beta" }) }, true), []);
  assert.match(b(GOOD, true).join(), /name is "PushArmor", want "PushArmor Beta"/);
  assert.match(check({ ...GOOD, "manifest.json": JSON.stringify({ name: "PushArmor Beta" }) }).join(), /want "PushArmor"$/);
  const betaFx = { name: "PushArmor Beta", browser_specific_settings: { gecko: { id: "beta@x", update_url: url } } };
  assert.deepEqual(b(fx(betaFx), false), []);
  assert.match(b(fx({ ...betaFx, browser_specific_settings: { gecko: { id: "beta@x" } } }), false).join(), /gecko update_url is null/);
  assert.match(check(fx({ name: "PushArmor", browser_specific_settings: { gecko: { id: "a@x", update_url: url } } }), false).join(), /gecko update_url is "https:/);
});

test("source maps, test entries and a missing manifest fail", () => {
  assert.match(check({ ...GOOD, "sw.js.map": "{}" }).join(), /sw\.js\.map: source map/);
  assert.match(check({ ...GOOD, "test/harness.js": "" }).join(), /test entry/);
  assert.match(check({ ...GOOD, "src/tests/x.js": "" }).join(), /test entry/);
  const { "manifest.json": _, ...noManifest } = GOOD;
  assert.match(check(noManifest).join(), /manifest\.json missing/);
});

test("placeholders, CI dummies and local endpoints fail", () => {
  assert.match(check({ ...GOOD, "sw.js": 'const k = "PLACEHOLDER_WEBPUSH_VAPID_PUBLIC_KEY";' }).join(), /PLACEHOLDER/);
  const fx = { ...GOOD, "manifest.json": JSON.stringify({ browser_specific_settings: { gecko: { id: "placeholder-addon-id@pusharmor.com" } } }) };
  assert.match(check(fx, false).join(), /manifest\.json: holds a PLACEHOLDER/);
  const dummy = { ...GOOD, "sw.js": 'const k = "ci-fork-dummy-webpush_vapid_public_key";' };
  assert.match(check(dummy).join(), /CI dummy/);
  assert.deepEqual(check(dummy, true, true), []);
  assert.match(check({ ...GOOD, "page.js": 'fetch("http://localhost:8787/v1")' }).join(), /local endpoint/);
  assert.match(check({ ...GOOD, "popup.html": '<a href="http://127.0.0.1/">' }).join(), /local endpoint/);
});

test("an entry not in the per-browser allow-list fails", () => {
  assert.match(check({ ...GOOD, "testhelper.js": "" }).join(), /testhelper\.js: entry not in release-allow\.json/);
  assert.match(check({ ...GOOD, "mocks/fake.js": "" }).join(), /mocks\/fake\.js: entry not in/);
  assert.match(check({ ...GOOD, "cs.js": "" }).join(), /cs\.js: entry not in/);
  assert.match(checkZip(zip({ ...GOOD_FX, "sw.js": "" }), { chrome: false }).join(), /sw\.js: entry not in/);
});

test("a globalThis.__ hook in shipped JS fails", () => {
  assert.match(check({ ...GOOD, "sw.js": "globalThis.__pa_test = { db };" }).join(), /sw\.js: sets or reads globalThis\.__/);
  assert.match(check({ ...GOOD, "page.js": 'globalThis["__pa"] = 1;' }).join(), /globalThis\.__/);
});

test("a runtime message op not in the allow-list fails", () => {
  const sw = 'switch (req2.op) {\n case "state":\n return 1;\n case "debugDump": {\n return dump();\n }\n}';
  assert.match(check({ ...GOOD, "sw.js": sw }).join(), /sw\.js: message op "debugDump" not in release-allow\.json/);
  const bg = 'if (msg.op === "fx-sub") x(); if (msg.op === "debugDump") return dump();';
  assert.match(check({ ...GOOD_FX, "background.js": bg }, false).join(), /message op "debugDump"/);
  assert.deepEqual(check({ ...GOOD, "sw.js": 'if (typeof m.op !== "string") return false; switch (r.op) { case "peers": { } case "fx-msg": }' }), []);
});

test("the op allow-list matches the runtime message handlers in the source", () => {
  const src = ["webext-common/src/core/rpc.ts", "webext-common/src/shellkit.ts", "chrome/src/sw.ts", "firefox/src/background.ts"]
    .map((f) => readFileSync(new URL("../../" + f, import.meta.url), "utf8"))
    .join("\n");
  const allow = JSON.parse(readFileSync(new URL("../release-allow.json", import.meta.url), "utf8"));
  assert.deepEqual(ops(src).sort(), [...allow.ops].sort());
});
