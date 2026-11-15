// Site SW forward: the webRequest listener result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FWD_MAX, SEEN_AGE_MS, SEEN_MAX, bridgeMsg, fwdAllowed, fwdSeen, onForward, readSub, type Seen } from "../../firefox/src/sitefwd/fwd.ts";

const req = (n: number) =>
  ({
    tabId: -1,
    type: "xmlhttprequest",
    method: "POST",
    originUrl: "https://pusharmor.com/fx/open",
    requestBody: { raw: [{ bytes: new Uint8Array(n).fill(65).buffer }] },
  }) as never;

test("forward: a delivered message is cancelled, a failed delivery goes to the network", async () => {
  const got: string[] = [];
  assert.deepEqual(await onForward(req(3), async (m) => void got.push(m)), { cancel: true });
  assert.deepEqual(got, ["AAA"]);
  assert.deepEqual(await onForward(req(3), async () => Promise.reject(new Error("db down"))), {});
});

test("forward: a too large body is cancelled without delivery; other requests pass", async () => {
  let n = 0;
  assert.deepEqual(await onForward(req(FWD_MAX + 1), async () => void n++), { cancel: true });
  assert.deepEqual(await onForward({ ...(req(3) as object), tabId: 5 } as never, async () => void n++), {});
  assert.equal(n, 0);
});

test("forward: the message cap is shared by the page relay and the background op", () => {
  assert.equal(fwdAllowed("a".repeat(FWD_MAX)), true);
  assert.equal(fwdAllowed("a".repeat(FWD_MAX + 1)), false);
  assert.equal(fwdAllowed(5), false);
  assert.equal(fwdAllowed(undefined), false);
});

test("a forwarded subscription change is read as fields; a pair or message wire is not", () => {
  const f = { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", p256dh: "P", auth: "A" };
  assert.deepEqual(readSub("sub:" + JSON.stringify(f)), f);
  assert.equal(readSub("sub:{"), null); // malformed: refused by the field check
  assert.equal(readSub("A".repeat(366)), undefined);
});

const seenStore = (clock: { t: number }) => {
  let saved: Seen | undefined;
  return { seen: fwdSeen(async () => saved, async (s) => void (saved = s), () => clock.t), get: () => saved };
};

test("/fx/open: a message the add-on already handled is acked without a second receive", async () => {
  const clock = { t: 1000 };
  const { seen } = seenStore(clock);
  const got: string[] = [];
  const receive = async (m: string) => void got.push(m);
  await onForward(req(3), async (m) => {
    await receive(m);
    await seen.add(m);
  });
  assert.deepEqual(await bridgeMsg("AAA", seen, receive), { ok: true }); // forwarded before: acked, not received again
  assert.deepEqual(await bridgeMsg("BBB", seen, receive), { ok: true }); // missed: received
  assert.deepEqual(await bridgeMsg("BBB", seen, receive), { ok: true }); // page died before its delete: acked only
  assert.deepEqual(got, ["AAA", "BBB"]);
});

test("/fx/open: a failed receive is not acked or recorded", async () => {
  const { seen } = seenStore({ t: 0 });
  await assert.rejects(bridgeMsg("AAA", seen, async () => Promise.reject(new Error("db down"))));
  assert.equal(await seen.has("AAA"), false);
});

test("the handled-message record keeps the site queue's cap and age", async () => {
  const clock = { t: 0 };
  const { seen, get } = seenStore(clock);
  await seen.add("old");
  clock.t = SEEN_AGE_MS + 1;
  assert.equal(await seen.has("old"), false);
  await Promise.all(Array.from({ length: SEEN_MAX + 5 }, (_, i) => seen.add("m" + i)));
  assert.equal(get()!.length, SEEN_MAX);
  assert.equal(await seen.has("m4"), false);
  assert.equal(await seen.has("m5"), true);
  assert.equal(await seen.has("m" + (SEEN_MAX + 4)), true);
});
