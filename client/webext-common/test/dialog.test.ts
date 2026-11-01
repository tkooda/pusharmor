// Confirm dialog and toast (ui/dialog.ts) on a small fake DOM: button order, Esc, focus
// restore, toast roles, auto-dismiss, and errors that stay.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { confirmDialog, dismissToast, toast } from "../src/ui/dialog.ts";

class N {
  tag: string;
  attrs: Record<string, string> = {};
  kids: N[] = [];
  parent: N | null = null;
  on: Record<string, ((ev: { target: N; preventDefault(): void }) => void)[]> = {};
  text = "";
  returnValue = "";
  open = false;
  cls = new Set<string>();
  style: Record<string, string> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k: string, f: (ev: { target: N; preventDefault(): void }) => void) {
    (this.on[k] ??= []).push(f);
  }
  removeEventListener(k: string, f: (ev: { target: N; preventDefault(): void }) => void) {
    this.on[k] = (this.on[k] ?? []).filter((x) => x !== f);
  }
  fire(k: string, target: N = this) {
    for (const f of [...(this.on[k] ?? [])]) f({ target, preventDefault() {} });
  }
  append(...xs: (N | string)[]) {
    for (const x of xs) {
      const n = typeof x === "string" ? Object.assign(new N("#text"), { text: x }) : x;
      n.parent = this;
      this.kids.push(n);
    }
  }
  remove() {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  contains(n: N | null): boolean {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  focus() {
    fake.activeElement = this;
  }
  click() {
    this.fire("click");
  }
  showModal() {
    this.open = true;
  }
  close(v?: string) {
    if (!this.open) return;
    this.open = false;
    if (v !== undefined) this.returnValue = v;
    this.fire("close");
  }
  get textContent(): string {
    return this.tag === "#text" ? this.text : this.text + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    this.kids = [];
    this.text = v;
  }
  get classList() {
    return { add: (c: string) => void this.cls.add(c), contains: (c: string) => this.cls.has(c) };
  }
  all(): N[] {
    return [this, ...this.kids.flatMap((k) => k.all())];
  }
}

const body = new N("body");
const doc = new N("#document");
const fake = {
  activeElement: null as N | null,
  body,
  createElement: (t: string) => new N(t),
  createTextNode: (s: string) => Object.assign(new N("#text"), { text: s }),
  createElementNS: (_: string, t: string) => new N(t),
  querySelector: () => null,
  addEventListener: doc.addEventListener.bind(doc),
  removeEventListener: doc.removeEventListener.bind(doc),
};
(globalThis as unknown as { document: unknown }).document = fake;

const buttons = (root: N) => root.all().filter((n) => n.tag === "button");
const dialog = () => body.kids.find((k) => k.tag === "dialog");
const toastEl = () => body.kids.find((k) => k.attrs.class?.startsWith("toast"));

test("confirm dialog: Cancel left, the action right; focus starts on Cancel; the action resolves true", async () => {
  const opener = new N("button");
  opener.focus();
  const p = confirmDialog("Delete all history?", "This deletes every message.", "Delete");
  const d = dialog()!;
  assert.ok(d.open, "shown with showModal");
  const [cancel, yes] = buttons(d);
  assert.equal(cancel!.textContent, "Cancel");
  assert.equal(yes!.textContent, "Delete");
  assert.match(yes!.attrs.class ?? "", /danger/);
  assert.equal(fake.activeElement, cancel);
  yes!.click();
  assert.equal(await p, true);
  assert.equal(dialog(), undefined, "removed after close");
  assert.equal(fake.activeElement, opener, "focus back on the opener");
});

test("confirm dialog: Esc and Cancel resolve false and put focus back", async () => {
  const opener = new N("button");
  opener.focus();
  let p = confirmDialog("Remove device?", "Remove Phone?", "Remove");
  dialog()!.close(); // Esc: the browser closes the modal without a return value
  assert.equal(await p, false);
  assert.equal(fake.activeElement, opener);
  p = confirmDialog("Remove device?", "Remove Phone?", "Remove");
  buttons(dialog()!)[0]!.click();
  assert.equal(await p, false);
  assert.equal(fake.activeElement, opener);
});

test("toast: ok and info are status messages that go after about 2 s", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    toast('Message sent to "Phone"', "ok");
    const el = toastEl()!;
    assert.equal(el.attrs.role, "status");
    mock.timers.tick(50);
    assert.equal(el.textContent, 'Message sent to "Phone"');
    assert.ok(el.classList.contains("on"));
    assert.equal(buttons(el).length, 0, "no Close button");
    mock.timers.tick(1900);
    assert.equal(toastEl(), el);
    mock.timers.tick(200);
    assert.equal(toastEl(), undefined);
  } finally {
    mock.timers.reset();
  }
});

test("toast: an error is an alert that stays until Close or the next click; a new message replaces it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    toast("Could not reach the relay server.", "err");
    let el = toastEl()!;
    assert.equal(el.attrs.role, "alert");
    mock.timers.tick(10_000);
    assert.equal(toastEl(), el, "still shown");
    buttons(el)[0]!.click();
    assert.equal(toastEl(), undefined, "Close dismisses it");

    toast("Could not reach the relay server.", "err");
    el = toastEl()!;
    mock.timers.tick(50);
    doc.fire("click", el.kids[0]!); // a click on the message itself keeps it
    assert.equal(toastEl(), el);
    doc.fire("click", new N("button")); // the next action elsewhere dismisses it
    assert.equal(toastEl(), undefined);

    toast("First error.", "err");
    toast("Renamed.", "ok");
    assert.equal(body.kids.filter((k) => k.attrs.class?.startsWith("toast")).length, 1, "one message at a time");
    dismissToast();
    assert.equal(toastEl(), undefined);
  } finally {
    mock.timers.reset();
  }
});

test("toast: a sticky message has a Close button and does not auto-dismiss (I626)", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    toast('Message saved to "/home/u/a.txt"', "ok", true);
    const el = toastEl()!;
    mock.timers.tick(60_000);
    assert.equal(toastEl(), el, "still shown");
    assert.equal(el.textContent.includes('Message saved to "/home/u/a.txt"'), true);
    assert.equal(buttons(el).length, 1);
    buttons(el)[0]!.click();
    assert.equal(toastEl(), undefined);
  } finally {
    mock.timers.reset();
  }
});
