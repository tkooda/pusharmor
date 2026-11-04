import assert from "node:assert/strict";
import { test } from "node:test";
import { N, body, toastEl } from "./fakedom.ts";
import { isLikelyUrl, sendAsUrlBox, urlToSend, userOffAfterEdit } from "../src/model/sendurl.ts";
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
});

test("Send as URL: the URL sent is the trimmed text, with https:// when it has no scheme", () => {
  assert.equal(urlToSend("  minilock.org  "), "https://minilock.org");
  assert.equal(urlToSend("HTTP://a.b.co/x?y#z"), "HTTP://a.b.co/x?y#z");
  assert.equal(urlToSend("http://a.com"), "http://a.com");
});

test("Send as URL: the box state", () => {
  assert.deepEqual(sendAsUrlBox("", false), { enabled: false, checked: false });
  assert.deepEqual(sendAsUrlBox("hello", false), { enabled: false, checked: false });
  assert.deepEqual(sendAsUrlBox("a.com", false), { enabled: true, checked: true });
  assert.deepEqual(sendAsUrlBox("a.com", true), { enabled: true, checked: false });
  assert.deepEqual(sendAsUrlBox("a.com x", true), { enabled: false, checked: false });
  assert.equal(userOffAfterEdit("", true), false);
  assert.equal(userOffAfterEdit("a", true), true);
});

const PEER = { id: "p1", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true };
const find = (n: N, f: (x: N) => boolean): N | undefined => (f(n) ? n : n.kids.map((k) => find(k, f)).find(Boolean));
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function mount(inPopup: boolean, result: unknown) {
  const sent: Record<string, unknown>[] = [];
  let closed = 0;
  (globalThis as unknown as { window: unknown }).window = { close: () => void closed++ };
  const env = {
    inPopup: () => inPopup,
    activeUrl: async () => "",
    call: async (m: { op: string; args?: Record<string, unknown> }) => {
      if (m.op === "send") sent.push(m.args!);
      const text = String(m.args?.text ?? "");
      const data: Record<string, unknown> = { peers: { peers: [PEER] }, sendSel: [], sendSelSet: null, detect: { type: detectType(text), bytes: text.length }, send: result };
      if (m.op === "send" && result instanceof Error) return { ok: false, error: result.message };
      return { ok: true, data: data[m.op] };
    },
  } as unknown as UiEnv;
  const root = new N("div");
  await sendView(env, root as unknown as HTMLElement, { settings: { showAll: false } } as unknown as StateView, "", false);
  const field = find(root, (x) => x.tag === "textarea") as N & { value: string };
  const box = find(root, (x) => x.tag === "input" && x.attrs.type === "checkbox") as N & { checked: boolean; disabled: boolean };
  const label = find(root, (x) => x.attrs.class === "asurl")!;
  const sendBtn = find(root, (x) => x.tag === "button" && (x.attrs.class ?? "").includes("primary"))!;
  const type = async (v: string) => {
    field.value = v;
    for (const f of field.on.input!) f({});
    await tick();
  };
  const untick = async (v: boolean) => {
    box.checked = v;
    for (const f of box.on.change!) f({});
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
  const urlRow = find(root, (x) => x.attrs.class === "urlrow")!;
  return { box, label, type, untick, send, sent, closed: () => closed, caption, textRow, tickText, meta, urlRow };
}

test("Send as URL: starts unticked and grey, ticks for a likely URL, and a user untick holds until a send or an empty field", async () => {
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  assert.equal(v.label.textContent, "Send as URL");
  assert.deepEqual([v.box.disabled, v.box.checked], [true, false]);
  await v.type("minilock.org");
  assert.deepEqual([v.box.disabled, v.box.checked], [false, true]);
  await v.untick(false);
  await v.type("minilock.");
  assert.deepEqual([v.box.disabled, v.box.checked], [true, false]);
  await v.type("minilock.org");
  assert.deepEqual([v.box.disabled, v.box.checked], [false, false], "enabled again, stays unticked");
  await v.send();
  assert.equal(v.sent[0]!.asUrl, false);
  assert.deepEqual([v.box.disabled, v.box.checked], [false, true], "a send resets to auto");
  await v.send();
  assert.equal(v.sent[1]!.asUrl, true);
  await v.untick(false);
  await v.type("");
  await v.type("a.com");
  assert.equal(v.box.checked, true, "an empty field resets to auto");
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

test("Send: a phone number shows its caption and the Send as text box, as before; other text and URLs do not", async () => {
  const v = await mount(false, { sent: 1, total: 1, failures: [] });
  await v.type("+1 555 123 4567");
  assert.deepEqual([v.caption.hidden, v.textRow.hidden, v.box.disabled, v.meta.hidden], [false, false, true, false]);
  assert.equal(v.urlRow.kids[0]!.attrs.class, "asurl"); // Send as URL on its own line
  assert.equal(v.caption.textContent, "Will open as a phone number");
  await v.send();
  assert.deepEqual([v.sent[0]!.asUrl, !!v.sent[0]!.asText], [false, false]);
  await v.tickText(true);
  assert.equal(v.caption.textContent, "Will arrive as text");
  await v.send();
  assert.equal(v.sent[1]!.asText, true);
  await v.tickText(false);
  for (const t of ["hello", "minilock.org", "https://1.2.3.4"]) {
    await v.type(t);
    assert.deepEqual([v.caption.hidden, v.textRow.hidden, v.meta.hidden], [true, true, true], t);
  }
  await v.type("x".repeat(1900));
  assert.deepEqual([v.meta.hidden, v.caption.hidden], [false, true]); // the counter shows
});
