// Q349: HTTP 426 shows a dedicated "Please update PushArmor" screen in the popup and the page.
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
  on: Record<string, () => void> = {};
  text = "";
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

test("426 from the relay server: popup and page show the update screen until the version changes", async () => {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  const rpc = new Rpc(a.e);
  assert.equal((await rpc.state()).updateRequired, false);
  w.inject.push({ match: /POST \/v1\/send/, status: 426, body: { error: "update required" }, times: 1 });
  await a.e.send("hi", false, "all");
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
      assert.ok(texts.includes("Please update PushArmor"));
      assert.ok(texts.some((t) => /no longer works with the relay server/.test(t)));
      const btn = all.find((n) => n.tag === "button")!;
      assert.equal(all.filter((n) => n.tag === "button").length, 1);
      btn.on.click!();
    });
  }
  assert.deepEqual(opened, ["https://pusharmor.com/download", "https://pusharmor.com/download"]);

  // a newer extension version starts clean
  (a.p as FakePlatform).appVersion = "0.0.20";
  assert.equal((await rpc.state()).updateRequired, false);
});
