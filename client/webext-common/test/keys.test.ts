// Keys that stop working: a local check at start and on popup open shows the keys
// screen; Retry checks again on this device only; Delete broken keys (after a
// confirmation) removes only the keys and keeps the register marker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Rpc, type StateView } from "../src/core/rpc.ts";
import { REG_MARKER } from "../src/core/state.ts";
import { memoryThemeStore } from "../src/ui/theme.ts";
import type { UiEnv } from "../src/ui/dom.ts";
import { mountPage } from "../src/ui/page.ts";
import { mountPopup } from "../src/ui/popup.ts";
import { Clock, MockWorker, device } from "./harness.ts";

async function brokenDevice() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const good = (await a.db.self())!;
  // an ECDH key cannot sign: the sign check throws, as a key the browser lost would
  await a.db.put("keys", { ...good, sign: good.enc }, "self");
  return { clock, w, a, good, rpc: new Rpc(a.e) };
}

const state = (rpc: Rpc) => rpc.state() as Promise<StateView & { keysBroken: boolean }>;

test("keys that fail the local check at start show the keys screen and stay saved", async () => {
  const { w, a, good, rpc } = await brokenDevice();
  const calls = w.calls.length;
  await a.e.start();
  assert.equal((await state(rpc)).keysBroken, true);
  assert.equal((await a.db.self())!.id, good.id);
  // popup open checks again and still keeps the keys
  const r = await rpc.handle({ op: "popupOpen" });
  assert.equal((r.data as { keysBroken: boolean }).keysBroken, true);
  assert.equal((await a.db.self())!.id, good.id);
  assert.equal(w.calls.length, calls, "no relay server call");
});

test("Retry with keys that work again leaves the keys screen with no relay server call", async () => {
  const { w, a, good, rpc } = await brokenDevice();
  await a.e.start();
  assert.equal((await state(rpc)).keysBroken, true);
  const calls = w.calls.length;
  assert.equal((await rpc.handle({ op: "keysRetry" })).ok, true);
  assert.equal((await state(rpc)).keysBroken, true); // still broken
  await a.db.put("keys", good, "self");
  assert.equal((await rpc.handle({ op: "keysRetry" })).ok, true);
  assert.equal((await state(rpc)).keysBroken, false);
  assert.equal(w.calls.length, calls);
});

test("Delete broken keys removes only the keys, keeps the marker, and the next sign-in deletes the old device", async () => {
  const { w, a, good, rpc } = await brokenDevice();
  await a.e.start();
  const calls = w.calls.length;
  assert.equal((await rpc.handle({ op: "keysDelete" })).ok, true);
  assert.equal(w.calls.length, calls, "no relay server call");
  assert.equal(await a.db.self(), undefined);
  assert.deepEqual((await a.p.storageLocal.get([REG_MARKER]))[REG_MARKER], { id: good.id, registered: true });
  const st = await state(rpc);
  assert.equal(st.keysBroken, false);
  assert.equal(st.reg, null); // the sign-in view
  assert.equal(await rpc.login.purpose(), "register");
  assert.equal(await a.e.register("T", "a@b.com"), null);
  const now = (await a.e.self())!;
  assert.notEqual(now.id, good.id);
  assert.ok(w.calls.some((c) => c.method === "DELETE" && c.path === "/v1/peers/" + good.id));
  assert.equal(w.rows.has(good.id), false);
});

test("Delete broken keys does nothing while the keys work or before a sign-in gave them an id", async () => {
  const { a, good, rpc } = await brokenDevice();
  await a.db.put("keys", good, "self");
  await rpc.handle({ op: "keysDelete" });
  assert.equal((await a.db.self())!.id, good.id);
  // a sign-in in progress: keys with no id yet
  await a.db.put("keys", { ...good, sign: good.enc, id: "" }, "self");
  await a.e.start();
  await rpc.handle({ op: "keysDelete" });
  assert.ok(await a.db.self());
});

test("Delete broken keys that cannot be saved says why in two lines and keeps the keys", async () => {
  const { a, good, rpc } = await brokenDevice();
  await a.e.start();
  const tx = a.db.tx.bind(a.db);
  a.db.tx = async () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  let r = await rpc.handle({ op: "keysDelete" });
  assert.deepEqual(r, { ok: false, error: "Unable to start the login.\nStorage is full. Free some space and try again." });
  a.db.tx = async () => {
    throw new DOMException("bad", "UnknownError");
  };
  r = await rpc.handle({ op: "keysDelete" });
  assert.deepEqual(r, { ok: false, error: "Unable to start the login.\nPushArmor could not save its data on this device. Restart PushArmor and try again." });
  a.db.tx = tx;
  assert.equal((await a.db.self())!.id, good.id);
  assert.equal((await state(rpc)).keysBroken, true);
});

// A tiny DOM: enough for h(), clear(), the keys screen, and the confirm dialog.
class N {
  kids: N[] = [];
  attrs: Record<string, string> = {};
  on: Record<string, () => unknown> = {};
  text = "";
  returnValue = "";
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
  remove() {
    body.kids = body.kids.filter((x) => x !== this);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  addEventListener(k: string, f: () => void) {
    this.on[k] = f;
  }
  showModal() {}
  close(v: string) {
    this.returnValue = v;
    this.on.close!();
  }
  focus() {}
  querySelector() {
    return null;
  }
  get classList() {
    return { toggle() {}, contains: () => false };
  }
  all(): N[] {
    return [this, ...this.kids.flatMap((k) => k.all())];
  }
}

let body = new N("body");
function withDom<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  body = new N("body");
  g.document = { createElement: (t: string) => new N(t), createTextNode: (s: string) => Object.assign(new N("#text"), { text: s }), body, documentElement: { dataset: {} }, activeElement: null };
  g.localStorage = { setItem() {} };
  return fn().finally(() => {
    delete g.document;
    delete g.localStorage;
  });
}

const label = (n: N) => n.kids.map((k) => k.text).join("");
const texts = (n: N) => n.all().filter((k) => k.tag === "#text").map((k) => k.text);
const buttons = (n: N) => n.all().filter((k) => k.tag === "button");
const tick = () => new Promise((r) => setImmediate(r));

test("keys screen: popup and page show it, Retry on the right, and Delete asks first", async () => {
  const { a, rpc } = await brokenDevice();
  await a.e.start();
  let stub = false; // the tiny DOM cannot draw the sign-in view: the redraw after Delete fails on purpose
  const env = {
    call: (r) => (stub && (r.op === "popupOpen" || r.op === "state") ? Promise.resolve({ ok: false, error: "stub" }) : rpc.handle(r)),
    activeUrl: async () => "",
    openPage: () => undefined,
    openUrl: () => undefined,
    saveFile: async () => null,
    copy: async () => undefined,
    beta: false,
    theme: memoryThemeStore("light"),
  } as UiEnv;
  for (const mount of [(r: HTMLElement) => mountPage(env, r, "#login", "chrome-extension://x"), (r: HTMLElement) => mountPopup(env, r)]) {
    await withDom(async () => {
      const root = new N("main");
      await mount(root as unknown as HTMLElement);
      const t = texts(root);
      assert.ok(t.includes("This device's keys have become unusable."));
      assert.ok(t.includes("Tap Retry to try again. If this keeps happening, you can delete the broken keys. You will then sign in again and pair all your devices again."));
      assert.deepEqual(buttons(root).map(label), ["Delete broken keys", "Retry"]);
    });
  }
  await withDom(async () => {
    const root = new N("main");
    await mountPopup(env, root as unknown as HTMLElement);
    const del = buttons(root)[0]!;
    // Cancel keeps the keys
    let done = del.on.click!() as Promise<void>;
    await tick();
    let dlg = body.kids.find((k) => k.tag === "dialog")!;
    assert.ok(texts(dlg).includes("Delete broken keys?"));
    assert.ok(texts(dlg).includes("This cannot be undone. You will need to pair all your devices again."));
    assert.deepEqual(buttons(dlg).map(label), ["Cancel", "Delete"]);
    buttons(dlg)[0]!.on.click!();
    await done;
    assert.ok(await a.db.self());
    // Delete removes them
    done = del.on.click!() as Promise<void>;
    await tick();
    dlg = body.kids.find((k) => k.tag === "dialog")!;
    stub = true;
    buttons(dlg)[1]!.on.click!();
    await done;
    assert.equal(await a.db.self(), undefined);
  });
});
