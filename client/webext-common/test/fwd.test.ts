// Site SW forward: the webRequest listener result.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FWD_MAX, fwdAllowed, onForward } from "../../firefox/src/sitefwd/fwd.ts";

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
