import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
// @ts-expect-error plain .mjs module without types
import { checkZip, readZip } from "../check-release.mjs";

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
const check = (files: Record<string, string>, chrome = true, dummyOk = false): string[] =>
  checkZip(zip(files), { chrome, dummyOk });

test("readZip reads stored and deflated entries", () => {
  const m = readZip(zip({ a: "one", b: "two", c: "three" }));
  assert.deepEqual([...m.keys()], ["a", "b", "c"]);
  assert.equal(m.get("c").toString(), "three");
});

test("a clean release zip passes (bare localhost word and input placeholders allowed)", () => {
  assert.deepEqual(check(GOOD), []);
  assert.deepEqual(check(GOOD, false), []);
});

test("Chrome manifest key fails; Firefox has no such rule", () => {
  const m = { ...GOOD, "manifest.json": JSON.stringify({ key: "MIIB" }) };
  assert.match(check(m).join(), /has a "key"/);
  assert.deepEqual(check(m, false), []);
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
