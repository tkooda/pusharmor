import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { addedDate } from "../src/crypto/labels.ts";
import { ownCard, renderPeers } from "../src/ui/peersview.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { N } from "./fakedom.ts";

// 9 account bytes, then keyhash || mac: the device ID is bytes 9..14 mod 1e9 (0x385805aabb = 241994934971)
const id = b64urlEncode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x38, 0x58, 0x05, 0xaa, 0xbb, 0xcc]));
const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];
const peer = (over: object) => ({ id: "p1", label: "Server", platform: "cli", lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: false, paired: false, ...over });
const paired = peer({ id: "p0", label: "Phone", platform: "android", paired: true });

async function draw(peers: object[]): Promise<N> {
  const env = { call: async () => ({ ok: true, data: { self: { id, name: "Me" }, peers } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  return root;
}
const texts = (r: N) => all(r).map((n) => n.textContent);

test("an unpaired command line row shows the pair command with the code", async () => {
  const r = await draw([paired, peer({})]);
  assert.ok(texts(r).includes('To pair, run this on "Server": pusharmor pair 994-934-971'));
  assert.ok(all(r).some((n) => n.tag === "code" && n.textContent === "pusharmor pair 994-934-971"));
});

test("no pair command for a paired command line row, a non-command-line row, or a hidden one", async () => {
  for (const other of [peer({ paired: true }), peer({ platform: "chrome" }), peer({ hidden: true })]) {
    const r = await draw([paired, other]);
    assert.ok(!texts(r).some((t) => t.includes("pusharmor pair")));
  }
});

test("the old This device's ID line is gone from the pairing screen and the pair dialog", async () => {
  for (const peers of [[], [paired]]) assert.ok(!texts(await draw(peers)).some((t) => t.includes("This device's ID")));
});

// golden-v1 device_id peer_N
const byClass = (r: N, c: string): N => all(r).find((n) => (n.attrs.class ?? "").split(" ").includes(c))!;
const realId = "CuVpna7--EmbFH3LCvfiANtnCurGpyStSXIO6AUz";

// The expected local day of a time, from the local Date getters (any time zone).
const localDay = (ms: number): string => {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
// Noon UTC on 2026-11-23 (the expected day follows the local time zone).
const added = 1795435200;

test("added date is the local day, YYYY-MM-DD", () => {
  assert.equal(addedDate(added * 1000), localDay(added * 1000));
  assert.match(addedDate(added * 1000), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(addedDate(new Date(2026, 0, 5, 0, 0, 0).getTime()), "2026-01-05");
  assert.equal(addedDate(new Date(2026, 0, 5, 23, 59, 59).getTime()), "2026-01-05");
});

test("a device row shows ID and Added lines under the platform, before the status line", async () => {
  const r = await draw([peer({ id: realId, label: "Phone", platform: "android", paired: true, created: added })]);
  const info = byClass(r, "info");
  assert.deepEqual(info.kids.slice(0, 3).map((n) => n.textContent), ["Android", "ID: 009-804-535", "Added: " + localDay(added * 1000)]);
});

test("a pair request card shows ID and Added lines under its title; after Codes match only the ID", async () => {
  const r = await draw([paired, peer({ id: realId, label: "New Firefox device", platform: "firefox", fingerprint: "YSWH", actions: ["approve", "deny"], created: added })]);
  const txt = byClass(byClass(r, "pair-head"), "txt");
  assert.deepEqual(txt.kids.map((n) => n.textContent), ["Pair with new Firefox device", "ID: 009-804-535", "Added: " + localDay(added * 1000)]);
  const r2 = await draw([paired, peer({ id: realId, label: "New Firefox device", platform: "firefox", fingerprint: "YSWH", actions: ["cancel"], awaiting: true, created: added })]);
  const txt2 = byClass(byClass(r2, "pair-head"), "txt");
  assert.deepEqual(txt2.kids.map((n) => n.textContent), ["Awaiting Firefox device's response", "ID: 009-804-535"]);
  const r3 = await draw([paired, peer({ id: realId, label: "Pixel 8", platform: "android", fingerprint: "YSWH", actions: ["approve", "deny"], created: added })]);
  assert.equal(byClass(byClass(r3, "pair-head"), "txt").kids[0]!.textContent, 'Pair with "Pixel 8"');
});

test("no Added line while the added time is unknown", async () => {
  const r = await draw([peer({ id: realId, label: "Phone", platform: "android", paired: true, created: 0 })]);
  assert.ok(texts(r).includes("ID: 009-804-535"));
  assert.ok(!texts(r).some((t) => t.startsWith("Added:")));
});

test("the own Settings card shows the Device ID under the name and no platform line", () => {
  const r = ownCard({} as UiEnv, "Work laptop", "chrome", realId) as unknown as N;
  const txt = byClass(r, "txt");
  assert.deepEqual(txt.kids.map((n) => n.textContent), ["Work laptop", "Device ID: 009-804-535"]);
});

test("the Added line is smaller and dimmer than the ID line on device cards, pairing cards, and the device-limit picker", async () => {
  const { readFileSync } = await import("node:fs");
  const r = await draw([paired, peer({ id: realId, label: "Phone", platform: "android", paired: true, created: added }), peer({ id: "p9", label: "New Firefox device", platform: "firefox", fingerprint: "YSWH", actions: ["approve", "deny"], created: added })]);
  const lines = all(r).filter((n) => n.tag === "div" && /^(ID|Added): /.test(n.textContent));
  assert.ok(lines.filter((n) => n.textContent.startsWith("Added: ")).length >= 2);
  for (const n of lines) assert.equal(n.attrs.class, n.textContent.startsWith("Added: ") ? "t2 added" : "t2", n.textContent);
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.match(page, /limitLines\(p\)\.map\(\(l\) => h\("div", \{ class: l\.startsWith\("Added: "\) \? "t2 added" : "t2" \}, l\)\)/);
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  const t2 = /\.dim, \.t2 \{ font-size: (\d+)px;/.exec(css)!;
  const add = /\.t2\.added \{ font-size: (\d+)px; line-height: [\d.]+; opacity: ([\d.]+); \}/.exec(css)!;
  assert.ok(Number(add[1]) < Number(t2[1]), "smaller");
  assert.ok(Number(add[2]) < 1, "dimmer");
});
