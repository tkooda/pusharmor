// 5xx and network errors: 3 tries in all, waits of 1 s then 3 s; 4xx never retried; noRetry opts out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Api, ApiError } from "../src/api/client.ts";

function mk(statuses: number[]) {
  const sleeps: number[] = [];
  let n = 0;
  const api = new Api({
    client: "chrome/0.0.1",
    fetch: async () => {
      const s = statuses[Math.min(n++, statuses.length - 1)]!;
      if (s === 0) throw new Error("offline");
      return new Response(s < 300 ? "{}" : JSON.stringify({ error: "x" }), { status: s });
    },
    now: () => 0,
    sleep: async (ms) => void sleeps.push(ms),
    getOffset: async () => 0,
    setOffset: async () => undefined,
  });
  return { api, sleeps, count: () => n };
}

test("a 500 is tried 3 times with waits of 1 s then 3 s, then the error shows", async () => {
  const t = mk([500]);
  await assert.rejects(t.api.call("POST", "/send", { body: {} }), (e: unknown) => e instanceof ApiError && e.status === 500);
  assert.equal(t.count(), 3);
  assert.deepEqual(t.sleeps, [1000, 3000]);
});

test("a 502, 504, and network error are retried; success on the 3rd try returns", async () => {
  for (const s of [502, 504, 0]) {
    const t = mk([s, s, 200]);
    const r = await t.api.call("GET", "/peers", {});
    assert.equal(r.status, 200);
    assert.deepEqual(t.sleeps, [1000, 3000]);
  }
});

test("a 400 and a 404 are not retried", async () => {
  for (const s of [400, 404]) {
    const t = mk([s]);
    await assert.rejects(t.api.call("POST", "/send", { body: {} }));
    assert.equal(t.count(), 1);
    assert.deepEqual(t.sleeps, []);
  }
});

test("noRetry makes one try only", async () => {
  const t = mk([503]);
  await assert.rejects(t.api.call("POST", "/pair/x", { body: {}, noRetry: true }));
  assert.equal(t.count(), 1);
});
