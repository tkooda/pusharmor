import assert from "node:assert/strict";
import { test } from "node:test";
import { applyFilter, historyChips } from "../src/ui/historyfilter.ts";
import { cleanCode, parseFragment } from "../src/core/login.ts";
import { MENU_PARENTS, selectionTitle } from "../src/core/actions.ts";
import { T } from "../src/core/texts.ts";
import { readForward } from "../../firefox/src/sitefwd/fwd.ts";
import { endpointAllowed } from "../../firefox/src/platform-firefox.ts";
import { senderAllowed } from "../../firefox/src/gate.ts";

test("History filter: chips All / peer names / Unknown, peer chips hidden with one peer", () => {
  const one = [
    { dir: "in" as const, peer: "A", sender: "Phone" },
    { dir: "out" as const, peer: null, sender: "" },
  ];
  assert.deepEqual(historyChips(one).map((c) => c.label), ["All"]);
  const rows = [...one, { dir: "in" as const, peer: "B", sender: "Laptop" }, { dir: "in" as const, peer: null, sender: "Unknown sender" }];
  assert.deepEqual(historyChips(rows).map((c) => c.label), ["All", "Phone", "Laptop", "Unknown"]);
  assert.deepEqual(applyFilter(rows, "A").rows, [rows[0]]); // received rows from that peer only
  assert.deepEqual(applyFilter(rows, "unknown").rows, [rows[3]]);
  assert.equal(applyFilter(one, "A").key, "all"); // resets to All
});

test("login code paste rules and OAuth fragment", () => {
  assert.equal(cleanCode("Your code: 7KQ-M9X."), "7KQM9X");
  assert.equal(cleanCode("7kq m9x"), "7KQM9X");
  assert.equal(cleanCode("1234567"), null);
  assert.deepEqual(parseFragment("https://x.chromiumapp.org/#ticket=abc&email=a%40b.com"), { ticket: "abc", email: "a@b.com" });
});

test("Firefox menu selection titles", () => {
  assert.equal(selectionTitle("https://example.com"), "PushArmor URL to");
  assert.equal(selectionTitle("+1 555-123-4567"), "PushArmor phone to");
  assert.equal(selectionTitle("hello"), "PushArmor text to");
});

test("context menu parent titles per context", () => {
  assert.deepEqual(MENU_PARENTS.map(([, title, ctx]) => [ctx, title]), [
    ["link", "PushArmor URL to"],
    ["page", "PushArmor URL to"],
    ["selection", "PushArmor selection to"],
  ]);
});

test("type captions and the pairing countdown text", () => {
  assert.equal(T.typeCaption("url"), "Will open as a link");
  assert.equal(T.typeCaption("text"), "Will arrive as text");
  assert.equal(T.typeCaption("tel"), "Will open as a phone number");
  assert.equal(T.countdownLeft("13 days"), "Times out in 13 days");
  assert.equal(T.countdownLeft("1 hour"), "Times out in 1 hour");
  assert.equal(T.counter(39), "39 / 2048");
});

test("fx/fwd catch: only the SW fetch, body concatenated, over 3800 bytes dropped", () => {
  const raw = (s: string) => ({ bytes: new TextEncoder().encode(s).buffer as ArrayBuffer });
  const base = { url: "https://pusharmor.com/fx/fwd", method: "POST", tabId: -1, type: "xmlhttprequest", originUrl: "https://pusharmor.com/fx/sw.js" };
  assert.deepEqual(readForward({ ...base, requestBody: { raw: [raw("AB"), raw("CD")] } }), { m: "ABCD", cancel: true });
  assert.deepEqual(readForward({ ...base, tabId: 3 }), { m: null, cancel: false });
  assert.deepEqual(readForward({ ...base, type: "main_frame" }), { m: null, cancel: false });
  assert.deepEqual(readForward({ ...base, originUrl: "https://evil.example/" }), { m: null, cancel: false });
  assert.deepEqual(readForward({ ...base, originUrl: undefined, requestBody: { raw: [raw("AB")] } }), { m: null, cancel: false }); // no origin: not the site SW
  assert.deepEqual(readForward({ ...base, requestBody: { raw: [raw("A".repeat(3801))] } }), { m: null, cancel: true });
});

test("Firefox fallback endpoint allow-list", () => {
  assert.ok(endpointAllowed("https://updates.push.services.mozilla.com/wpush/v2/abc"));
  assert.ok(endpointAllowed("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!endpointAllowed("https://updates.push.services.mozilla.com:444/wpush/v2/abc"));
  assert.ok(!endpointAllowed("https://u:p@fcm.googleapis.com/fcm/send/abc"));
  assert.ok(!endpointAllowed("https://evil.example/wpush/v2/"));
  assert.ok(!endpointAllowed("http://fcm.googleapis.com/fcm/send/abc"));
});

test("Firefox sender gate: a site content script gets only its own site op", () => {
  const id = "ext@pusharmor";
  const base = "moz-extension://1111-2222/";
  const site = (path: string) => ({ id, url: "https://pusharmor.com" + path, tab: { id: 7 } });
  for (const op of ["approve", "send", "deny", "historyDeleteAll", "peers"]) {
    assert.equal(senderAllowed(op, site("/fx/open"), id, base), false, op);
    assert.equal(senderAllowed(op, site("/auth/done"), id, base), false, op);
    assert.equal(senderAllowed(op, { id, url: base + "popup.html" }, id, base), true, op);
    assert.equal(senderAllowed(op, { id, url: base + "page.html#peers", tab: { id: 3 } }, id, base), true, op);
  }
  assert.equal(senderAllowed("fx-sub", site("/fx/setup"), id, base), true);
  assert.equal(senderAllowed("fx-msg", site("/fx/open"), id, base), true);
  assert.equal(senderAllowed("authDone", site("/auth/done"), id, base), true);
  assert.equal(senderAllowed("fx-msg", site("/fx/setup"), id, base), false);
  assert.equal(senderAllowed("authDone", site("/fx/open"), id, base), false);
  assert.equal(senderAllowed("fx-sub", { id, url: base + "popup.html" }, id, base), false);
  assert.equal(senderAllowed("approve", { id: "other", url: base + "popup.html" }, id, base), false);
  assert.equal(senderAllowed("approve", { id }, id, base), false);
});
