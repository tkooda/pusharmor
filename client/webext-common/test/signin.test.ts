import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_RESULT_MS, RESEND_MS, RESTORE_MS, clampFrameHeight, readAuthResult, readProgress, resendLeftMs, restoreStep } from "../src/model/signin.ts";

const T0 = 1_800_000_000_000;
const code = (o: Record<string, unknown> = {}) => ({ v: 1, step: "code", email: "sam@example.com", purpose: "register", sentAt: T0, ...o });

test("sign-in progress: a code step younger than 14 min opens step 2", () => {
  assert.equal(RESTORE_MS, 14 * 60_000); // Worker code life 900 s less a 60 s margin
  assert.deepEqual(restoreStep(code(), T0 + 5 * 60_000, "register", true), { step: "code", email: "sam@example.com", note: "restored", sentAt: T0 });
  assert.equal(restoreStep(code(), T0 + RESTORE_MS - 1, "register", true)?.step, "code");
});

test("sign-in progress: an old code or a missing request token opens step 1 with the expired note", () => {
  const expired = { step: "email", email: "sam@example.com", note: "expired", sentAt: T0 };
  assert.deepEqual(restoreStep(code(), T0 + RESTORE_MS, "register", true), expired);
  assert.deepEqual(restoreStep(code(), T0 + 60 * 60_000, "register", true), expired);
  assert.deepEqual(restoreStep(code(), T0 + 60_000, "register", false), expired);
  // a send time in the future (clock moved back) is not trusted
  assert.deepEqual(restoreStep(code(), T0 - 5 * 60_000, "register", true), expired);
});

test("sign-in progress: an email step keeps the email; another purpose or bad data is discarded", () => {
  assert.deepEqual(restoreStep({ v: 1, step: "email", email: "a@b.c", purpose: "register", sentAt: 0 }, T0, "register", false), {
    step: "email", email: "a@b.c", note: null, sentAt: 0,
  });
  assert.equal(restoreStep(code(), T0 + 60_000, "delete-account", true), null);
  assert.equal(restoreStep(undefined, T0, "register", true), null);
  assert.equal(restoreStep(code({ v: 2 }), T0, "register", true), null);
  assert.equal(restoreStep(code({ step: "done" }), T0, "register", true), null);
  assert.equal(restoreStep(code({ email: 5 }), T0, "register", true), null);
  assert.equal(restoreStep(code({ sentAt: "x" }), T0, "register", true), null);
  assert.equal(readProgress(code({ email: "x".repeat(321) })), null);
});

test("resend countdown counts from the saved send time", () => {
  assert.equal(RESEND_MS, 60_000);
  assert.equal(resendLeftMs(T0, T0 + 18_000), 42_000);
  assert.equal(resendLeftMs(T0, T0 + 61_000), 0);
  assert.equal(resendLeftMs(T0, T0 + 10 * 60_000), 0);
});

test("Turnstile frame height is clamped to 65..600; junk is ignored", () => {
  assert.equal(clampFrameHeight(65), 65);
  assert.equal(clampFrameHeight(140.2), 141);
  assert.equal(clampFrameHeight(0), 65);
  assert.equal(clampFrameHeight(-5), 65);
  assert.equal(clampFrameHeight(5000), 600);
  assert.equal(clampFrameHeight(Number.NaN), null);
  assert.equal(clampFrameHeight(Number.POSITIVE_INFINITY), null);
  assert.equal(clampFrameHeight("120"), null);
  assert.equal(clampFrameHeight(undefined), null);
});

test("login result from the background: well formed and recent only (I456)", () => {
  assert.deepEqual(readAuthResult({ done: true, at: T0 }, T0 + 1000), { done: true, at: T0 });
  assert.deepEqual(readAuthResult({ done: false, limit: { peers: [] }, ticket: "t", at: T0 }, T0), { done: false, limit: { peers: [] }, ticket: "t", at: T0 });
  assert.equal(readAuthResult({ done: false, error: "Login expired, log in again", at: T0 }, T0)?.error, "Login expired, log in again");
  assert.equal(readAuthResult({ done: true, at: T0 }, T0 + AUTH_RESULT_MS + 1), null);
  assert.equal(readAuthResult({ done: true, at: T0 + 1 }, T0), null);
  assert.equal(readAuthResult({ done: "yes", at: T0 }, T0), null);
  assert.equal(readAuthResult(undefined, T0), null);
});
