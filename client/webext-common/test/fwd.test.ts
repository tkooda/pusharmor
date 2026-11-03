// Site SW forward: the webRequest listener result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FWD_MAX, fwdAllowed, onForward, readSub } from "../../firefox/src/sitefwd/fwd.ts";

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
