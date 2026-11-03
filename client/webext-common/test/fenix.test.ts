// Firefox for Android (fallback mode): the push subscription is the site's, stored once
// (platform-firefox.ts), and every message arrives through the site SW forward that the
// background page catches (background.ts webRequest listener).
import assert from "node:assert/strict";
import { test } from "node:test";
import { onForward, readSub } from "../../firefox/src/sitefwd/fwd.ts";
import type { PushFields } from "../src/crypto/labels.ts";
import { b64urlDecode } from "../src/crypto/b64url.ts";
import { Rpc } from "../src/core/rpc.ts";
import { getEntry } from "../src/core/state.ts";
import { Clock, type Device, MockWorker, deliver, device, refresh } from "./harness.ts";

const SITE_SUB: PushFields = { type: "webpush", endpoint: "https://updates.push.services.mozilla.com/wpush/v2/site", p256dh: "P", auth: "A" };

/** A Firefox for Android add-on: no own push client, the stored site subscription only. */
async function fenix(w: MockWorker, clock: Clock): Promise<Device> {
  const d = await device(w, clock, "firefox");
  d.p.isAndroid = true;
  d.p.sub = SITE_SUB;
  d.p.pushSubscribe = async () => SITE_SUB;
  await d.e.pushReconcile();
  return d;
}

/** Delivers queued pushes the way the site SW does: a POST to /fx/fwd that the add-on catches. */
async function forward(w: MockWorker, d: Device): Promise<number> {
  const ms = w.take(d.id);
  for (const m of ms) {
    const req = {
      url: "https://pusharmor.com/fx/fwd",
      method: "POST",
      tabId: -1,
      type: "xmlhttprequest",
      originUrl: "https://pusharmor.com/fx/sw.js",
      requestBody: { raw: [{ bytes: new TextEncoder().encode(m).buffer as ArrayBuffer }] },
    };
    const r = await onForward(req, async (x) => {
      assert.equal(readSub(x), undefined);
      await d.e.receive(x, "push");
    });
    assert.deepEqual(r, { cancel: true });
  }
  return ms.length;
}

async function shownBoth(x: Device, y: Device) {
  assert.equal((await getEntry(x.p.storageLocal, y.id))!.state, "shown");
  assert.equal((await getEntry(y.p.storageLocal, x.id))!.state, "shown");
  const fx = (await x.e.pairRowView(y.id))!.fingerprint;
  assert.ok(fx && fx === (await y.e.pairRowView(x.id))!.fingerprint);
}

test("Firefox for Android: Pair there reaches compare codes through the site forward", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const f = await fenix(w, clock);
  const o = await device(w, clock);
  await refresh(f, o);
  await f.e.pairStart(o.id);
  assert.equal(await deliver(w, o), 1); // commit -> reply
  assert.equal(await forward(w, f), 1); // reply -> codes, open
  assert.equal(await deliver(w, o), 1); // open -> codes
  await shownBoth(f, o);
});

test("Firefox for Android: crossing Pair taps reach compare codes through the site forward", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const f = await fenix(w, clock);
  const o = await device(w, clock);
  await refresh(f, o);
  await f.e.pairStart(o.id);
  await o.e.pairStart(f.id);
  for (let i = 0; i < 20; i++) if ((await forward(w, f)) + (await deliver(w, o)) === 0) break;
  await shownBoth(f, o);
  const fLower = Buffer.compare(Buffer.from(b64urlDecode(f.id)), Buffer.from(b64urlDecode(o.id))) < 0;
  assert.equal((await getEntry(f.p.storageLocal, o.id))!.role, fLower ? "N" : "X");
});

test("Firefox for Android: Refresh fetches the list and PATCHes the unchanged site subscription no more", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const f = await fenix(w, clock);
  const patches = () => w.calls.filter((c) => c.method === "PATCH" && c.path === "/v1/peers/" + f.id && "push" in (c.body as object)).length;
  const gets = () => w.calls.filter((c) => c.method === "GET" && c.path === "/v1/peers").length;
  const p0 = patches();
  const g0 = gets();
  const rpc = new Rpc(f.e);
  for (let i = 0; i < 3; i++) {
    clock.t += 60_000;
    await rpc.handle({ op: "refresh" });
  }
  assert.equal(gets() - g0, 3);
  assert.equal(patches() - p0, 0);
});
