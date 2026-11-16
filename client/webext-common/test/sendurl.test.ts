import assert from "node:assert/strict";
import { test } from "node:test";
import { N, body, toastEl } from "./fakedom.ts";
import { isLikelyUrl, sentLength, urlToSend } from "../src/model/sendurl.ts";
import { sendView } from "../src/ui/popup.ts";
import { detectType } from "../src/model/detect.ts";
import type { StateView } from "../src/core/rpc.ts";
import type { UiEnv } from "../src/ui/dom.ts";

test("Send as URL: the likely-URL rule", () => {
  for (const s of ["minilock.org", "  minilock.org  ", "https://minilock.org", "HTTP://a.b.co/x?y#z", "sub.example.com:8080/path", "example.com/", "xn--bcher-kva.xn--p1ai"]) {
    assert.equal(isLikelyUrl(s), true, s);
  }
  for (const s of ["minilock.", "minilockorg", "minilock.;org", "minilock .org", "", "   ", "a..com", "-a.com", "1.2.3.4", "hello world.com", "localhost", "ftp://x.com"]) {
    assert.equal(isLikelyUrl(s), false, s);
  }
  for (const s of ["a-.com", "a.com:", "a.com:8x", "a.c", "a.c0m", "x".repeat(64) + ".com", "https://", "a.com\tb"]) assert.equal(isLikelyUrl(s), false, s);
  assert.equal(isLikelyUrl("x".repeat(63) + ".com?q"), true);
  // with a scheme there is no host check
  assert.equal(isLikelyUrl("https://1.2.3.4"), true);
  assert.equal(isLikelyUrl("http://localhost:8080/x"), true);
  assert.equal(isLikelyUrl("https://"), false);
});

test("Send as URL: the URL sent is the trimmed text, with https:// when it has no scheme", () => {
  assert.equal(urlToSend("  minilock.org  "), "https://minilock.org");
  assert.equal(urlToSend("HTTP://a.b.co/x?y#z"), "HTTP://a.b.co/x?y#z");
  assert.equal(urlToSend("http://a.com"), "http://a.com");
});

const PEER = { id: "p1", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true };
const textBoxOf = (v: { textRow: N }) => find(v.textRow, (x) => x.tag === "input") as N & { checked: boolean };
const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

let gate: Promise<void> | null = null;

async function mount(inPopup: boolean, result: unknown, peers: unknown[] = [PEER], sel: string[] = [], pick?: string) {
  const sent: Record<string, unknown>[] = [];
  let closed = 0;
  (globalThis as unknown as { window: unknown }).window = { close: () => void closed++ };
  const env = {
    inPopup: () => inPopup,
    activeUrl: async () => "",
    call: async (m: { op: string; args?: Record<string, unknown> }) => {
      if (m.op === "send") sent.push(m.args!);
      if (m.op === "send" && gate) await gate;
      const text = String(m.args?.text ?? "");
      const data: Record<string, unknown> = { peers: { peers }, sendSel: sel, sendSelSet: null, detect: { type: detectType(text), bytes: text.length }, send: result };
      if (m.op === "send" && result instanceof Error) return { ok: false, error: result.message };
      return { ok: true, data: data[m.op] };
    },
  } as unknown as UiEnv;
  const root = new N("div");
  await sendView(env, root as unknown as HTMLElement, { settings: { showAll: false } } as unknown as StateView, "", undefined, pick);
  const field = find(root, (x) => x.tag === "textarea") as N & { value: string };
  const sendBtn = find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("primary"))!;
  const type = async (v: string) => {
    field.value = v;
    for (const f of field.on.input!) f({});
    await tick();
  };
  const send = async () => {
    for (const f of sendBtn.on.click!) f({});
    await tick();
    await new Promise((r) => setTimeout(r, 60)); // the toast text goes in after 50 ms
  };
  const caption = find(root, (x) => x.attrs.class === "caption") as N & { hidden: boolean };
  const textRow = find(root, (x) => x.attrs.class === "astext") as N & { hidden: boolean };
  const textBox = find(textRow, (x) => x.tag === "input") as N & { checked: boolean };
  const tickText = async (v: boolean) => {
    textBox.checked = v;
    for (const f of textBox.on.change!) f({});
    await tick();
  };
  const meta = find(root, (x) => x.attrs.class === "meta") as N & { hidden: boolean };
  const counter = find(root, (x) => x.attrs.class === "counter") as N & { textContent: string };
  const chipsOn = () => (find(root, (x) => x.attrs.class === "dchips")!.kids.filter((c) => (c.attrs.class ?? "").includes("dchip")) as N[]).filter((c) => c.classList.contains("on")).map((c) => c.attrs.title);
  return { chipsOn, type, send, sent, closed: () => closed, caption, textRow, tickText, meta, sendBtn, counter };
}

test("Send: the type line always shows; a URL is sent as URL unless Send as text is ticked, and the override is for one send", async () => {
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  assert.deepEqual([!!v.caption.hidden, !!v.textRow.hidden, v.caption.textContent], [false, true, "Will be sent as text"]);
  await v.type("minilock.org");
  assert.deepEqual([!!v.textRow.hidden, v.caption.textContent], [false, "Will be sent as URL"]);
  await v.send();
  assert.deepEqual([v.sent[0]!.asUrl, v.sent[0]!.asText], [true, false]);
  await v.tickText(true);
  assert.equal(v.caption.textContent, "Will be sent as text");
  await v.send();
  assert.deepEqual([v.sent[1]!.asUrl, v.sent[1]!.asText], [false, true]);
  assert.equal(textBoxOf(v).checked, false, "a send clears the override");
  await v.tickText(true);
  await v.type("minilock.org/x"); // still a URL: the override stays
  assert.equal(v.caption.textContent, "Will be sent as text");
  await v.type("+1 555 123 4567"); // the type changed: the override is cleared
  assert.deepEqual([textBoxOf(v).checked, v.caption.textContent], [false, "Will be sent as phone number"]);
  await v.type("hello");
  assert.deepEqual([!!v.textRow.hidden, v.caption.textContent], [true, "Will be sent as text"]);
  await v.type("");
  assert.equal(!!v.caption.hidden, false);
});

test("Send: the toolbar popup closes after a sent message; a full tab or Firefox for Android shows the toast; a failure keeps it open", async () => {
  const ok = { sent: 1, total: 1, failures: [] };
  const pop = await mount(true, ok);
  await pop.type("hi");
  await pop.send();
  assert.equal(pop.closed(), 1);
  const tab = await mount(false, ok);
  await tab.type("hi");
  await tab.send();
  assert.equal(tab.closed(), 0);
  assert.equal(toastEl()?.textContent, 'Message sent to "Phone"');
  const fail = await mount(true, { sent: 0, total: 1, failures: [], error: "Unable to send.\nThe relay server could not be reached." });
  await fail.type("hi");
  await fail.send();
  assert.equal(fail.closed(), 0);
  assert.match(toastEl()!.textContent, /^Unable to send\n/);
  const thrown = await mount(true, new Error("Unable to send.\nNo"));
  await thrown.type("hi");
  await thrown.send();
  assert.equal(thrown.closed(), 0);
  for (const k of [...body.kids]) k.remove();
});

test("Send: a phone number shows its caption and the Send as text box; other text shows only the caption", async () => {
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  await v.type("+1 555 123 4567");
  assert.deepEqual([!!v.caption.hidden, !!v.textRow.hidden, !!v.meta.hidden], [false, false, false]);
  assert.equal(v.caption.textContent, "Will be sent as phone number");
  await v.send();
  assert.deepEqual([v.sent[0]!.asUrl, !!v.sent[0]!.asText], [false, false]);
  await v.tickText(true);
  assert.equal(v.caption.textContent, "Will be sent as text");
  await v.send();
  assert.equal(v.sent[1]!.asText, true);
  await v.type("hello");
  assert.deepEqual([!!v.caption.hidden, !!v.textRow.hidden, !!v.meta.hidden], [false, true, false]);
  await v.type("x".repeat(1900));
  assert.deepEqual([!!v.meta.hidden, !!v.caption.hidden], [false, false]); // the counter shows too
});

test("Send: a URL that is too long once https:// is added greys out Send, like too-long text; Send as text turns it back on", async () => {
  assert.equal(sentLength("a.com", true), 13);
  assert.equal(sentLength("a.com", false), 5);
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  const btn = v.sendBtn as N & { disabled: boolean };
  const url = "a.com/" + "x".repeat(2000 - 6 - 4); // 1996 characters, 2004 with https://
  await v.type(url);
  assert.equal(v.caption.textContent, "Will be sent as URL");
  assert.equal(btn.disabled, true);
  assert.equal(v.counter.textContent, "Too long (2004 / 2000)");
  await v.tickText(true);
  assert.equal(btn.disabled, false);
  await v.tickText(false);
  await v.type("https://a.com/" + "x".repeat(2000 - 14));
  assert.equal(btn.disabled, false, "a URL with its scheme at the cap still sends");
});

test("Send: while a send runs a modal popup shows the caption and the bar, and it is gone after", async () => {
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  await v.type("hi");
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const run = v.send();
  await tick();
  const dlg = body.kids.find((k) => k.tag === "dialog")!;
  assert.ok(dlg);
  assert.equal(find(dlg, (x) => x.tag === "span")!.textContent, 'Sending text to "Phone"...');
  assert.equal(find(dlg, (x) => x.tag === "progress")!.attrs.value, "25");
  assert.equal(find(dlg, (x) => x.attrs.role === "status")!.textContent, 'Encrypting for "Phone"');
  assert.equal(v.sendBtn.attrs.disabled === undefined, true);
  gate = null;
  release();
  await run;
  assert.equal(body.kids.some((k) => k.tag === "dialog"), false);
  for (const k of [...body.kids]) k.remove();
});

test("Send: with several recipients the popup caption ends in a colon and the devices are listed one per line, without quotes", async () => {
  const v = await mount(false, { sent: 2, total: 2, failures: [] }, [PEER, { ...PEER, id: "p2", label: "Laptop" }], ["p1", "p2"]);
  await v.type("hi");
  let release!: () => void;
  gate = new Promise<void>((r) => (release = r));
  const run = v.send();
  await tick();
  const dlg = body.kids.find((k) => k.tag === "dialog")!;
  assert.equal(find(dlg, (x) => x.tag === "span")!.textContent, "Sending text to:");
  const ul = find(dlg, (x) => x.tag === "ul")!;
  assert.deepEqual(ul.kids.map((k) => k.textContent), ["Phone", "Laptop"]);
  gate = null;
  release();
  await run;
  for (const k of [...body.kids]) k.remove();
});

test("Send: the text box has focus when the toolbar popup opens, not in a full tab or on Firefox for Android", async () => {
  const focused: string[] = [];
  const old = N.prototype.focus;
  N.prototype.focus = function (this: N) {
    focused.push(this.tag);
  };
  try {
    await mount(true, { ok: [] });
    assert.deepEqual(focused, ["textarea"]);
    focused.length = 0;
    await mount(false, { ok: [] });
    assert.deepEqual(focused, []);
  } finally {
    N.prototype.focus = old;
  }
});

test("Send: a device picked in the right-click menu is the one selected, not the remembered devices", async () => {
  const two = [PEER, { ...PEER, id: "p2", label: "Laptop" }];
  assert.deepEqual((await mount(false, { ok: [] }, two, ["p1"])).chipsOn(), ["Phone"]);
  assert.deepEqual((await mount(false, { ok: [] }, two, ["p1"], "p2")).chipsOn(), ["Laptop"]);
  // a device that is not on the list leaves the remembered selection
  assert.deepEqual((await mount(false, { ok: [] }, two, ["p1"], "gone")).chipsOn(), ["Phone"]);
});
