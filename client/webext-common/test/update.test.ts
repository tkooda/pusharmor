// HTTP 426 shows a dedicated "Unable to connect." update screen in the popup and the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc } from "../src/core/rpc.ts";
import { memoryThemeStore } from "../src/ui/theme.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { mountPage } from "../src/ui/page.ts";
import { mountPopup } from "../src/ui/popup.ts";
import { Clock, FakePlatform, MockWorker, device, pairAndApprove } from "./harness.ts";

// A tiny DOM: enough for h(), clear(), and the update screen.
class N {
  kids: N[] = [];
  attrs: Record<string, string> = {};
  on: Record<string, () => unknown> = {};
  text = "";
  disabled = false;
  set textContent(s: string) {
    this.kids = [Object.assign(new N("#text"), { text: s })];
  }
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  get firstChild() {
    return this.kids[0] ?? null;
  }
  append(...k: N[]) {
    this.kids.push(...k);
  }
  removeChild(k: N) {
    this.kids = this.kids.filter((x) => x !== k);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: () => void) {
    this.on[k] = f;
  }
  focus() {}
  querySelector() {
    return null;
  }
  get classList() {
    return { toggle() {} };
  }
  all(): N[] {
    return [this, ...this.kids.flatMap((k) => k.all())];
  }
}

function withDom<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (t: string) => new N(t), createTextNode: (s: string) => Object.assign(new N("#text"), { text: s }), body: new N("body"), documentElement: { dataset: {} } };
  g.localStorage = { setItem() {} };
  return fn().finally(() => {
    delete g.document;
    delete g.localStorage;
  });
}

const label = (n: N) => n.kids.map((k) => k.text).join("");
const isOff = (n: N) => n.disabled || "disabled" in n.attrs;

test("426 from the relay server: popup and page show the update screen until the version changes", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  const rpc = new Rpc(a.e);
  assert.equal((await rpc.state()).updateRequired, false);
  w.inject.push({ match: /POST \/v1\/send/, status: 426, body: { error: "update required" }, times: 1 });
  await a.e.send("hi", "auto", "all");
  assert.equal((await rpc.state()).updateRequired, true);

  const opened: string[] = [];
  const env = {
    call: (r) => rpc.handle(r),
    activeUrl: async () => "",
    openPage: () => undefined,
    openUrl: (u: string) => void opened.push(u),
    saveFile: async () => null,
    copy: async () => undefined,
    beta: false,
    theme: memoryThemeStore("light"),
  } as UiEnv;
  for (const mount of [(r: HTMLElement) => mountPopup(env, r), (r: HTMLElement) => mountPage(env, r, "#history", "chrome-extension://x")]) {
    await withDom(async () => {
      const root = new N("main") as unknown as HTMLElement;
      await mount(root);
      const all = (root as unknown as N).all();
      const texts = all.filter((n) => n.tag === "#text").map((n) => n.text);
      assert.ok(texts.includes("Unable to connect."));
      assert.ok(texts.includes("This version of PushArmor is too old. Update PushArmor to continue."));
      const btns = all.filter((n) => n.tag === "button");
      assert.deepEqual(btns.map(label), ["Check again", "Update"]); // the affirmative action on the right
      btns[1]!.on.click!();
    });
  }
  assert.deepEqual(opened, ["https://pusharmor.com/download", "https://pusharmor.com/download"]);

  // a newer extension version starts clean
  (a.p as FakePlatform).appVersion = "0.0.20";
  assert.equal((await rpc.state()).updateRequired, false);
});

test("Check again asks the relay server at most once an hour and leaves the update screen when it accepts this version", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const rpc = new Rpc(a.e);
  w.floor = "0.0.20"; // this device runs 0.0.19
  await a.e.fetchPeersNow().catch(() => undefined);
  assert.equal((await rpc.state()).updateRequired, true);
  let opens = 0;
  let stubOpen = false; // the tiny DOM cannot draw the full popup: the redraw after the check fails on purpose
  const env = {
    call: (r) => {
      if (r.op === "popupOpen") opens++;
      return stubOpen && r.op === "popupOpen" ? Promise.resolve({ ok: false, error: "stub" }) : rpc.handle(r);
    },
    activeUrl: async () => "",
    openPage: () => undefined,
    openUrl: () => undefined,
    saveFile: async () => null,
    copy: async () => undefined,
    beta: false,
    theme: memoryThemeStore("light"),
  } as UiEnv;
  const health = () => w.calls.filter((c) => c.method === "GET" && c.path === "/v1/health");
  const open = async () => {
    const root = new N("main");
    await mountPopup(env, root as unknown as HTMLElement);
    return root;
  };
  const check = (root: N) => root.all().filter((n) => n.tag === "button")[0]!; // left of Update
  await withDom(async () => {
    // still refused: the screen stays and the button is locked for the hour
    let root = await open();
    let btn = check(root);
    assert.equal(label(btn), "Check again");
    assert.equal(isOff(btn), false);
    await btn.on.click!();
    assert.equal(health().length, 1);
    assert.equal(health()[0]!.client, "chrome/0.0.19");
    assert.equal((await rpc.state()).updateRequired, true);
    root = await open();
    btn = check(root);
    assert.equal(label(btn), "Try again later.");
    assert.ok(isOff(btn));
    // within the hour: no request even when asked directly
    w.floor = "0.0.1";
    await rpc.handle({ op: "recheck" });
    assert.equal(health().length, 1);
    assert.equal((await rpc.state()).updateRequired, true);
    // after the hour the button is enabled again; the relay server now accepts this version
    clock.t += 3600_000;
    root = await open();
    btn = check(root);
    assert.equal(label(btn), "Check again");
    assert.equal(isOff(btn), false);
    stubOpen = true;
    const before = opens;
    await btn.on.click!();
    assert.equal(opens, before + 1); // the popup draws again
    assert.equal(health().length, 2);
    assert.equal((await rpc.state()).updateRequired, false);
  });
});
