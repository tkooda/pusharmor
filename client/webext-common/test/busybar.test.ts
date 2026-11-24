// The busy bar under a long action: a bar that fills by steps, or a spinner when there is no step count.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { type UiEnv, busyBar } from "../src/ui/dom.ts";
import { STEP } from "../src/model/busy.ts";

const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));

function mount() {
  let cb: ((v: unknown) => void) | null = null;
  const env = { session: { watch: (_k: string, f: (v: unknown) => void) => ((cb = f), () => (cb = null)) } } as unknown as UiEnv;
  const b = busyBar(env);
  const el = b.el as unknown as N;
  const bar = find(el, (x) => x.tag === "progress") as N & { value: number; max: number; hidden: boolean };
  const spin = find(el, (x) => (x.attrs.class ?? "").split(" ").includes("fp-spin")) as (N & { hidden: boolean }) | undefined;
  const cap = find(el, (x) => x.attrs.role === "status")!;
  return { b, bar, spin, cap, write: (v: unknown) => cb?.(v) };
}

test("busy bar: with the steps of the action it is a bar that fills by the step its caption is on", () => {
  const m = mount();
  m.b.start(STEP.checkingCode, [STEP.checkingCode, STEP.setUp, STEP.loading]);
  assert.deepEqual([m.bar.hidden, m.spin?.hidden, m.bar.value, m.bar.max], [false, true, 1, 4]);
  assert.equal(m.cap.textContent, "Checking the code");
  m.write({ cap: STEP.setUp });
  assert.deepEqual([m.bar.value, m.bar.max], [2, 4]);
  m.write({ cap: STEP.loading });
  assert.deepEqual([m.bar.value, m.bar.max, m.cap.textContent], [3, 4, "Loading your devices"]);
  // a caption seen again does not move the bar back
  m.write({ cap: STEP.setUp });
  assert.equal(m.bar.value, 3);
});

test("busy bar: counts from the background make it a bar; no step count shows a spinner, never a bar that slides", () => {
  const m = mount();
  m.b.start(STEP.loggingOut);
  assert.ok(m.spin, "a spinner is there");
  assert.deepEqual([m.bar.hidden, m.spin!.hidden, m.cap.textContent], [true, false, "Logging out"]);
  m.b.stop();
  m.b.start();
  m.write({ cap: "Deleting on your other devices (1 of 3)", done: 1, total: 3 });
  assert.deepEqual([m.bar.hidden, m.spin!.hidden, m.bar.value, m.bar.max], [false, true, 1, 3]);
  // one step only: nothing to count
  m.b.stop();
  m.b.start(undefined, [STEP.deletingAccount]);
  m.write({ cap: STEP.deletingAccount });
  assert.deepEqual([m.bar.hidden, m.spin!.hidden], [true, false]);
});

test("busy bar: the sign-in bars carry the steps the background writes", () => {
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.match(page, /signBar\.start\(STEP\.checkingCode, purpose === "delete-account" \? \[STEP\.checkingCode, STEP\.deletingAccount\] : \[STEP\.checkingCode, STEP\.setUp, STEP\.loading\]\)/);
  assert.match(page, /oauthBar\.start\(undefined, purpose === "delete-account" \? \[STEP\.deletingAccount\] : \[STEP\.setUp, STEP\.loading\]\)/);
  assert.match(page, /evictBar\.start\(STEP\.removing\(names\), \[STEP\.removing\(names\), STEP\.loggingIn\]\)/);
  assert.match(page, /evictBar\.start\(STEP\.setUp, \[STEP\.setUp, STEP\.loading\]\)/);
});
