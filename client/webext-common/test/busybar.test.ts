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

test("Send popup: a file shows a spinner while it is encrypted, then a bar of the bytes uploaded that never goes back", async () => {
  const { body } = await import("./fakedom.ts");
  const { sendProgress } = await import("../src/ui/popup.ts");
  let cb: ((v: unknown) => void) | null = null;
  const env = { session: { watch: (_k: string, f: (v: unknown) => void) => ((cb = f), () => (cb = null)) } } as unknown as UiEnv;
  const prog = sendProgress(env, 'Sending "a.pdf" to "Phone"...', STEP.encryptingFor(["Phone"]), ["Phone"], true);
  const dlg = body.kids.find((k) => k.tag === "dialog")!;
  const bar = find(dlg, (x) => x.tag === "progress") as N & { value: number; hidden: boolean };
  bar.value = Number(bar.attrs.value); // a real progress element reflects its value attribute
  const spin = find(dlg, (x) => (x.attrs.class ?? "").split(" ").includes("fp-spin")) as N & { hidden: boolean };
  const cap = find(dlg, (x) => x.attrs.role === "status")!;
  const write = (v: unknown) => cb?.(v);
  assert.deepEqual([bar.hidden, spin.hidden, cap.textContent], [true, false, 'Encrypting for "Phone"']);
  write({ cap: STEP.encryptingFor(["Phone"]) });
  assert.deepEqual([bar.hidden, spin.hidden], [true, false]);
  write({ cap: STEP.sendingTo(["Phone"]), done: 0, total: 100 });
  assert.deepEqual([bar.hidden, spin.hidden, bar.value, cap.textContent], [false, true, 0, 'Sending to "Phone"']);
  write({ cap: STEP.sendingTo(["Phone"]), done: 40, total: 100 });
  assert.equal(bar.value, 40);
  // the message steps after the upload do not move the bar back or bring the spinner back
  write({ cap: STEP.sendingTo(["Phone"]), done: 2, total: 4 });
  assert.deepEqual([bar.hidden, spin.hidden, bar.value], [false, true, 50]);
  write({ cap: STEP.encryptingFor(["Phone"]), done: 1, total: 4 });
  assert.equal(bar.value, 50);
  prog.close();
});

test("History: a file that is decrypting shows a spinner, never a bar that slides", () => {
  const popup = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const at = popup.indexOf('case "decrypting":');
  const arm = popup.slice(at, popup.indexOf("break;", at));
  assert.doesNotMatch(arm, /h\("progress"/);
  assert.match(arm, /class: "fp-spin", role: "status", "aria-label": "Decrypting " \+ r\.content/);
});
