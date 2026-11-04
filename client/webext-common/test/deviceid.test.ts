import assert from "node:assert/strict";
import { test } from "node:test";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import { type UiEnv, shortDeviceId } from "../src/ui/dom.ts";
import { N } from "./fakedom.ts";

// 9 account bytes, then keyhash || mac: the CLI shows hex of bytes 9.. (first 6 chars)
const id = b64urlEncode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0x38, 0x58, 0x05, 0xaa, 0xbb, 0xcc]));
const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("short device id is the first 6 hex chars after the account bytes", () => {
  assert.equal(shortDeviceId(id), "385805");
});

test("the pairing screen shows This device's ID", async () => {
  for (const peers of [[], [{ id: "p1", label: "Phone", platform: "android", lines: [], actions: ["remove"], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true }]]) {
    const env = { call: async () => ({ ok: true, data: { self: { id, name: "Me" }, peers } }) } as unknown as UiEnv;
    const root = new N("div");
    await renderPeers(env, root as unknown as HTMLElement, false);
    assert.ok(all(root).some((n) => n.textContent === "This device's ID: 385805"), String(peers.length));
  }
});
