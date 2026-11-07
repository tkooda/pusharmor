import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import { type UiEnv, shortDeviceId } from "../src/ui/dom.ts";
import { N } from "./fakedom.ts";

// 9 account bytes, then keyhash || mac: the CLI shows hex of bytes 9.. (first 6 chars)
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

test("short device id is the first 6 hex chars after the account bytes", () => {
  assert.equal(shortDeviceId(id), "385805");
});

test("an unpaired command line row shows the pair command with the code", async () => {
  const r = await draw([paired, peer({})]);
  assert.ok(texts(r).includes('To pair, run this on "Server": pusharmor pair 385805'));
  assert.ok(all(r).some((n) => n.tag === "code" && n.textContent === "pusharmor pair 385805"));
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
