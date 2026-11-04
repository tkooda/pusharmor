// Settings: the build's version at the bottom; a click copies it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { N, body, toastEl } from "./fakedom.ts";
import { copyText, versionButton } from "../src/ui/popup.ts";
import { dismissToast } from "../src/ui/dialog.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { Rpc } from "../src/core/rpc.ts";
import { Clock, MockWorker, device } from "./harness.ts";

test("Settings version line: a button that copies just the version", async () => {
  const copied: string[] = [];
  const env = { copy: async (t: string) => void copied.push(t) } as unknown as UiEnv;
  const b = versionButton(env, "1.2.3") as unknown as N;
  assert.equal(b.tag, "button");
  assert.equal(b.attrs.type, "button");
  assert.equal(b.attrs["aria-label"], "Copy version");
  assert.equal(b.textContent, "Version 1.2.3");
  assert.match(b.attrs.class!, /\bt2\b/); // the muted secondary text style
  for (const f of b.on.click!) f({});
  assert.deepEqual(copied, ["1.2.3"]);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(toastEl()?.textContent, "Copied");
  dismissToast();
});

test("copy: a written clipboard shows Copied; a refused write shows the two-line error", async () => {
  const wait = () => new Promise((r) => setTimeout(r, 60));
  await copyText({ copy: async () => undefined } as unknown as UiEnv, "x");
  await wait();
  assert.equal(toastEl()?.textContent, "Copied");
  assert.equal(toastEl()?.attrs.class, "toast ok");
  await copyText({ copy: async () => Promise.reject(new Error("NotAllowedError")) } as unknown as UiEnv, "x");
  await wait();
  assert.equal(toastEl()?.textContent, "Unable to copy\nSelect the text and copy it by hand");
  assert.match(toastEl()!.attrs.class!, /^toast err\b/);
  dismissToast();
  body.kids = [];
});

test("copy: the History Copy button and the version line both go through copyText", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("env.copy(r.content)") && !src.includes("env.copy(version)"));
  assert.equal(src.match(/copyText\(env, /g)?.length, 2);
});

test("Settings version line: the version is the build's, from the manifest, and sits last", async () => {
  const clock = new Clock();
  const d = await device(new MockWorker(clock), clock);
  d.p.appVersion = "4.5.6";
  assert.equal((await new Rpc(d.e).state()).version, "4.5.6");
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.ok(rd("shellkit.ts").includes("appVersion: b.runtime.getManifest().version,"));
  assert.ok(rd("ui/popup.ts").includes('h("div", { class: "grow" }),\n    versionButton(env, st.version),\n  );'));
});
