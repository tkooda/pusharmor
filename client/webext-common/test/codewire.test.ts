// The sign-in code field: a rejected code is not sent again after an edit back to it.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UiEnv } from "../src/ui/dom.ts";
import { mountPage } from "../src/ui/page.ts";
import { memoryThemeStore } from "../src/ui/theme.ts";

class N {
  kids: N[] = [];
  attrs: Record<string, string> = {};
  on: Record<string, ((ev?: unknown) => unknown)[]> = {};
  text = "";
  value = "";
  hidden = false;
  disabled = false;
  id = "";
  className = "";
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  set textContent(s: string) {
    this.kids = [Object.assign(new N("#text"), { text: s })];
  }
  get firstChild() {
    return this.kids[0] ?? null;
  }
  append(...k: N[]) {
    this.kids.push(...k);
  }
  prepend(...k: N[]) {
    this.kids.unshift(...k);
  }
  removeChild(k: N) {
    this.kids = this.kids.filter((x) => x !== k);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  removeAttribute(k: string) {
    delete this.attrs[k];
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k: string, f: (ev?: unknown) => unknown) {
    (this.on[k] ??= []).push(f);
  }
  focus() {}
  blur() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get classList() {
    return { toggle() {}, add() {}, remove() {}, contains: () => false };
  }
  get style() {
    return {};
  }
  all(): N[] {
    return [this, ...this.kids.flatMap((k) => k.all())];
  }
}

test("the sign-in code field does not send the same rejected code again after an edit back to it", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (t: string) => new N(t),
    createTextNode: (s: string) => Object.assign(new N("#text"), { text: s }),
    createElementNS: (_n: string, t: string) => new N(t),
    body: new N("body"),
    documentElement: { dataset: {} },
    addEventListener() {},
  };
  g.localStorage = { setItem() {} };
  g.window = { addEventListener() {}, removeEventListener() {}, close() {} };
  const verifies: string[] = [];
  const env = {
    call: async (r: { op: string; args?: Record<string, unknown> }) => {
      if (r.op === "emailVerify") {
        verifies.push(String(r.args?.code));
        return { ok: false, error: "That code is not right." };
      }
      if (r.op === "state") return { ok: true, data: { platform: "chrome", reg: "none", updateRequired: false, keysBroken: false } };
      if (r.op === "loginPurpose") return { ok: true, data: "login" };
      if (r.op === "signinProgress") return { ok: true, data: { step: "code", email: "a@example.com", sentAt: Date.now() - 3_600_000 } };
      return { ok: true, data: null };
    },
    activeUrl: async () => "",
    openPage: () => undefined,
    openUrl: () => undefined,
    saveFile: async () => null,
    copy: async () => undefined,
    beta: false,
    theme: memoryThemeStore("light"),
  } as unknown as UiEnv;
  try {
    const root = new N("main");
    await mountPage(env, root as unknown as HTMLElement, "#login", "chrome-extension://x");
    const code = root.all().find((n) => n.tag === "input" && n.attrs.class === "code")!;
    const type = async (v: string) => {
      code.value = v;
      for (const f of code.on.input ?? []) f();
      await new Promise((r) => setTimeout(r, 10));
    };
    await type("ABC123"); // six characters: checked and rejected
    await type("ABC1234"); // edit
    await type("ABC123"); // edit back to the rejected code
    assert.deepEqual(verifies, ["ABC123"]);
    await type("ABC124"); // a different code is checked
    assert.deepEqual(verifies, ["ABC123", "ABC124"]);
  } finally {
    delete g.document;
    delete g.localStorage;
    delete g.window;
  }
});
