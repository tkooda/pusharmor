// Content script relay: retry only while the receiving end is missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayRetry } from "../../firefox/src/sitefwd/relay.ts";

test("relay: retries after a rejected send until it resolves", async () => {
  let n = 0;
  const sleeps: number[] = [];
  const r = await relayRetry(
    async () => {
      if (++n <= 3) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { ok: true };
    },
    async (ms) => void sleeps.push(ms),
  );
  assert.deepEqual(r, { ok: true });
  assert.equal(n, 4);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
});

test("relay: a resolved reply is never retried, even with ok false", async () => {
  let n = 0;
  const r = await relayRetry(async () => (n++, { ok: false }), async () => undefined);
  assert.deepEqual(r, { ok: false });
  assert.equal(n, 1);
});

test("relay: gives up after 10 tries", async () => {
  let n = 0;
  const r = await relayRetry(async () => { n++; throw new Error("x"); }, async () => undefined);
  assert.equal(r, undefined);
  assert.equal(n, 10);
});
