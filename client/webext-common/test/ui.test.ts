import assert from "node:assert/strict";
import { test } from "node:test";
import type { PeerView } from "../src/core/rpc.ts";
import { accountLine, fitMiddle, nextTabIndex, peerStatus, platformLabel, shortTime } from "../src/ui/dom.ts";

const peer = (o: Partial<PeerView>): PeerView => ({
  id: "x", label: "Phone", platform: "android", lines: [], actions: [], countdown: null, fingerprint: null, pk: null,
  greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true, ...o,
});

test("peer status line by priority, replaced by pairing and note lines", () => {
  assert.deepEqual(peerStatus(peer({ greyed: "(missing)" })), { kind: "off", word: "(missing)" });
  assert.deepEqual(peerStatus(peer({ greyed: "logged out" })), { kind: "off", word: "Logged out" });
  assert.deepEqual(peerStatus(peer({ greyed: "unreachable" })), { kind: "off", word: "Unreachable" });
  assert.deepEqual(peerStatus(peer({ greyed: "send only" })), { kind: "off", word: "Send only" });
  assert.deepEqual(peerStatus(peer({})), { kind: "ok", word: "Paired" });
  assert.deepEqual(peerStatus(peer({ approvesMe: false, sendable: false })), { kind: "wait", word: "Has not approved this device" });
  assert.deepEqual(peerStatus(peer({ approvesMe: false, sendable: false, actions: ["pair", "deny"] })), { kind: "wait", word: "Ready to pair" }); // I492
  assert.equal(peerStatus(peer({ greyed: "Declined by Phone" })), null); // note line takes its place
  assert.equal(peerStatus(peer({ lines: ["Pairing with Phone"] })), null);
  assert.equal(peerStatus(peer({ fingerprint: "K7QD" })), null);
  assert.equal(platformLabel("ios"), "iPhone");
  assert.equal(platformLabel("firefox"), "Firefox");
  assert.equal(platformLabel("cli"), "Command line");
});

test("middle ellipsis keeps head and tail with exactly one ...", () => {
  const url = "https://www.example.com/recipes/2026/10/weeknight-lemon-pasta";
  assert.equal(fitMiddle(url, (s) => s.length <= 80), url);
  const s = fitMiddle(url, (x) => x.length <= 30);
  assert.equal(s.length, 30);
  assert.equal(s.split("...").length, 2);
  assert.ok(s.startsWith("https://www.exampl")); // head two thirds
  assert.ok(s.endsWith("mon-pasta")); // tail one third
  assert.equal(fitMiddle(url, () => false), "...");
});

test("short History time: clock today, Yesterday, else month and day", () => {
  const now = new Date(2026, 9, 29, 15, 0).getTime();
  assert.equal(shortTime(new Date(2026, 9, 29, 9, 24).getTime(), now), new Date(2026, 9, 29, 9, 24).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  assert.equal(shortTime(new Date(2026, 9, 28, 23, 59).getTime(), now), "Yesterday");
  assert.equal(shortTime(new Date(2026, 9, 1, 8, 0).getTime(), now), new Date(2026, 9, 1).toLocaleDateString([], { month: "short", day: "numeric" }));
});

test("History sender link is a keyboard-operable button with a visible focus ring", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(src, /h\("button", \{ class: "who peerlink", type: "button" \}/); // native Tab, Enter and Space
  assert.match(src, /who\.addEventListener\("click"/); // click is what Enter and Space fire on a button
  assert.match(css, /^:focus-visible \{ outline: 2px solid/m); // global ring
  assert.doesNotMatch(css, /peerlink[^{]*\{[^}]*outline: ?none/);
});

test("status and error text is announced: live regions and field errors wired to inputs", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  for (const f of ["popup.ts", "peersview.ts", "page.ts"]) assert.doesNotMatch(rd(f), /class: "status" \}/, f); // every status div has a role
  assert.match(rd("popup.ts"), /class: "result", role: "status"/);
  const page = rd("page.ts");
  assert.match(page, /setAttribute\("role", "alert"\)/); // bad help is an alert
  assert.match(page, /setAttribute\("aria-invalid", "true"\)/);
  assert.match(page, /describe\(email, emailHelp/);
  assert.match(page, /describe\(code, codeHelp/);
  assert.match(page, /setHelp\(emailHelp, bad, true, email\)/);
  assert.match(page, /setHelp\(codeHelp, msg[^\n]*, true, code\)/);
  assert.match(rd("peersview.ts"), /await redraw\(msg, p\.id\)/); // the message survives the redraw
});

test("tab keys: arrows wrap, Home and End jump, others pass", () => {
  assert.equal(nextTabIndex("ArrowRight", 3, 4), 0);
  assert.equal(nextTabIndex("ArrowRight", 0, 4), 1);
  assert.equal(nextTabIndex("ArrowLeft", 0, 4), 3);
  assert.equal(nextTabIndex("Home", 2, 4), 0);
  assert.equal(nextTabIndex("End", 0, 4), 3);
  assert.equal(nextTabIndex("a", 0, 4), null);
});

test("popup tabs are a full tab widget; headings, main landmark, reduced motion", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const pop = rd("popup.ts");
  assert.match(pop, /role: "tabpanel"/);
  assert.match(pop, /"aria-controls": "panel"/);
  assert.match(pop, /"aria-labelledby", "tab-"/);
  assert.match(pop, /setAttribute\("tabindex", on \? "0" : "-1"\)/);
  assert.match(pop, /tabs\.addEventListener\("keydown"/);
  assert.match(rd("dom.ts"), /h\("h2", \{ class: "sh"/);
  for (const f of ["popup.html", "page.html"]) assert.match(rd(f), /<main id="app">/);
  assert.match(rd("style.css"), /prefers-reduced-motion: reduce/);
});

test("focus moves sensibly on view change, dialogs and errors", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const page = rd("page.ts");
  assert.match(page, /heading\.focus\(\)/); // done step and limit view
  assert.match(page, /h\("h1", \{ tabindex: "-1" \}/);
  const peers = rd("peersview.ts");
  assert.match(peers, /await redraw\(msg, p\.id\)/); // focus returns to the row after an action
  assert.match(peers, /\.sh"\)\)\?\.focus\(\)/); // or the first heading when the row is gone
  assert.match(peers, /edit\.focus\(\)/); // after Rename
  assert.match(peers, /\.keep"\)\?\.focus\(\)/); // remove confirm
  const pop = rd("popup.ts");
  assert.doesNotMatch(pop, /yes\.focus\(\)/); // I471: confirms start on Cancel, not on the destructive button
  assert.equal(pop.match(/no\.focus\(\)/g)?.length, 1); // Delete all history
  assert.match(pop, /confirmDel\.addEventListener\("keydown", onEsc/);
  assert.match(pop, /h\("button", \{ onclick: closeDel \}, "Cancel"\)/);
  assert.match(pop, /"aria-label": "Unread"/);
  assert.match(pop, /content\.addEventListener\("keydown"/); // keyboard marks read
});

test("a failed start shows the error with a Retry button in the popup and the tab", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  assert.match(rd("dom.ts"), /export function failView/);
  assert.match(rd("dom.ts"), /"Retry"/);
  assert.match(rd("popup.ts"), /failView\(root, \(e as Error\)\.message, \(\) => void mountPopup\(env, root\)\)/);
  assert.match(rd("page.ts"), /failView\(root, \(e as Error\)\.message, \(\) => void mountPage\(/);
});

test("popup views render into a per-show pane, so a stale tab cannot mix rows into the current one", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /const pane = h\("div"/);
  assert.match(pop, /body\.append\(pane\)/);
  assert.doesNotMatch(pop, /(sendView|historyView|renderPeers|settingsView)\(env, body/);
});

test("firefox background retries a failed start on every use of ready (alarms, push, messages)", async () => {
  const { readFileSync } = await import("node:fs");
  const bg = readFileSync(new URL("../../firefox/src/background.ts", import.meta.url), "utf8");
  assert.match(bg, /const whenReady = \(\) => \(ready = ready\.catch\(\(\) => init\(\)\)\)/);
  assert.doesNotMatch(bg, /ready\.then\(/);
});

test("firefox background drops autopush when start() throws, so the retry starts it again", async () => {
  const { readFileSync } = await import("node:fs");
  const bg = readFileSync(new URL("../../firefox/src/background.ts", import.meta.url), "utf8");
  assert.match(bg, /try \{\s*await autopush\.start\(\);\s*\} catch \(e\) \{[^}]*autopush\.stop\(\);\s*autopush = null;\s*throw e;/);
  assert.match(bg, /if \(!isAndroid && !autopush\)/);
});

test("Log out acts at once: no confirm, one signout call, Delete account still opens its page (Q367)", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.doesNotMatch(rd("core/texts.ts"), /logoutConfirm/);
  const popup = rd("ui/popup.ts");
  assert.doesNotMatch(popup, /logoutConfirm|confirmOut|closeConfirm/);
  assert.doesNotMatch(rd("ui/style.css"), /confirm-out/);
  assert.ok(popup.includes('const logOut = h("button", {\n    onclick: async () => {\n      try {\n        await rpc(env, "signout");'));
  assert.ok(popup.includes('group(acctRow, h("div", { class: "srow acct-acts" }, btns))'));
  assert.ok(popup.includes('env.openPage("#login=delete-account")'));
  assert.equal(popup.split('rpc(env, "signout")').length, 2, "only one signout call");
});

test("settings account line is hidden while logged out", () => {
  assert.equal(accountLine({ email: "a@b.co", reg: "registered" }), "Logged in as a@b.co");
  assert.equal(accountLine({ email: "a@b.co", reg: "logged_out" }), null);
  assert.equal(accountLine({ email: null, reg: "registered" }), null);
});

test("popup size is fixed in static CSS: no viewport-relative width, one height on every tab (I458)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  const body = /\nbody \{([^}]*)\}/.exec(css)![1]!;
  assert.match(body, /width: 400px;/);
  assert.match(body, /height: 560px;/);
  assert.doesNotMatch(body, /vw|max-height/);
  assert.match(readFileSync(new URL("../src/ui/popup.html", import.meta.url), "utf8"), /<link rel="stylesheet" href="style.css">/);
});

test("popup header stays mounted: only the content area scrolls, reset on each tab, with a loading line (I464)", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(/\nbody \{([^}]*)\}/.exec(css)![1]!, /overflow: hidden;/);
  assert.match(css, /#panel \{[^}]*overflow-y: auto;/);
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /body\.scrollTop = 0;/);
  assert.match(pop, /class: "loading", role: "status" \}, "Loading\.\.\."/);
  assert.match(pop, /clear\(body\);/); // a tab switch replaces the content area only
});

test("Settings: Open links automatically sits under Receiving, not Sending (I463)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const recv = pop.indexOf('sh("Receiving")');
  assert.ok(recv > pop.indexOf('sh("Sending")'));
  assert.ok(pop.indexOf('"Open links automatically"') > recv);
});

test("Log out confirmed: the popup reads the state again and shows the logged-out view (I465)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const call = pop.indexOf('await rpc(env, "signout");');
  assert.ok(call > 0);
  assert.match(pop.slice(call, call + 200), /await reload\(\);/);
  assert.match(pop, /settingsView\(env, pane, st, \(\) => mountPopup\(env, root\)\)/);
});

test("Settings polish: dim label and email line, brighter dark headers and error text, drawn select (I460)", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  assert.match(rd("popup.ts"), /h\("div", \{ class: "t2" \}, "Logged in as"\), h\("div", \{ class: "t1 email"/);
  const css = rd("style.css");
  assert.match(css, /\.acct \.email \{[^}]*text-overflow: ellipsis;/);
  assert.match(css, /select \{[^}]*appearance: none;/);
  for (const b of ["chrome", "firefox"]) {
    const t = rd("tokens-" + b + ".css");
    assert.equal(t.split("--err: #FFB4AB;").length, 3, b + ": both dark blocks");
    assert.equal(t.split("--sh: #CBD3DC;").length, 3, b + ": both dark blocks");
  }
});

test("Devices footer: Refresh and Open full view share one outlined style in the brand accent; balanced empty text (I461)", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const css = rd("style.css");
  assert.match(css, /\.foot\.bar button \{[^}]*color: var\(--accent, var\(--primary\)\);/);
  assert.match(css, /\.empty p \{[^}]*text-wrap: balance;/);
  assert.doesNotMatch(rd("peersview.ts"), /class: "quiet", onclick: \(\) => env\.openPage\("#peers"\)/);
  for (const b of ["chrome", "firefox"]) assert.equal(rd("tokens-" + b + ".css").split("--accent: #34C77B;").length, 3);
});

test("no paired device: popup and page show the first-device screen, which switches to the tabs after the first pairing (Q338)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /if \(first && !first\.peers\.some\(\(p\) => p\.paired\)\) return firstPairView\(env, root, st, \(\) => mountPopup\(env, root\), true\);/);
  assert.match(pop, /"Pair your first device"/);
  assert.match(pop, /"Install PushArmor on another device\."/);
  assert.match(pop, /"No devices yet\. They show up here after they log in\."/);
  assert.match(pop, /if \(data\.peers\.some\(\(p\) => p\.paired\)\) \{\s*clearInterval\(timer\);\s*await onPaired\(\);/);
  assert.match(pop, /"aria-label": "Settings"/);
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.match(page, /return firstPairView\(env, root, st, \(\) => mountPage\(env, root, hash, selfOrigin\), false\)/);
});

test("login page: one note at a time, setup note only while needed with Open setup, resume has no step counter (I459)", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Finish logging in in the new tab/);
  assert.match(page, /first \?\?\s*\(st\.banner/); // the first available note only
  assert.match(page, /ff && st\.setupNeeded \? setupNote\(\)/);
  assert.match(page, /"Open setup"/);
  assert.match(page, /resuming \? null : h\("p", \{ class: "step-n" \}, "Step 1 of 2"\)/);
  assert.match(page, /"You are logged out\. Log in to resume\."/);
  const texts = readFileSync(new URL("../src/core/texts.ts", import.meta.url), "utf8");
  assert.match(texts, /ffFinishSetup: "Finish setup in the Firefox setup tab\.",/);
  assert.match(texts, /signedOut: "Logged out\. Log in to resume\.",/);
});

test("Turnstile loads only when the email field is used; a send waits for the check (I467)", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /let frame = newFrame\(\);/); // no frame at mount
  assert.match(page, /let frame: HTMLElement = h\("div", \{ class: "ts-slot", hidden: true \}\);/);
  assert.match(page, /email\.addEventListener\("focus", loadFrame\);/);
  assert.match(page, /email\.addEventListener\("input", loadFrame\);/); // paste and autofill fire input
  assert.match(page, /"Waiting for the security check\.\.\."/);
  const oauth = page.slice(page.indexOf("const oauth ="), page.indexOf("const oauth =") + 400);
  assert.doesNotMatch(oauth, /loadFrame|freshFrame/);
  for (const b of ["chrome", "firefox"]) {
    const m = readFileSync(new URL("../../" + b + "/manifest.json", import.meta.url), "utf8");
    assert.match(m, /frame-src https:\/\/pusharmor\.com/);
  }
});

test("full tab account views are gated on login; no hash shows Devices (I470)", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");
  const route = page.slice(page.indexOf("async function mountRoute"), page.indexOf("const E2E"));
  const gate = route.indexOf('if (st.reg !== "registered")');
  assert.ok(gate > 0);
  for (const v of ["historyView(", "sendView(", "renderPeers(", "firstPairView("]) assert.ok(route.indexOf(v) > gate, v);
  assert.match(route, /signinCard\(env, st, going, true\)/);
  assert.doesNotMatch(route, /h\("div", \{\}, "PushArmor"\)/); // the old blank page
});

test("one request per click; a failed tab view shows Retry (I473)", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = (f: string) => readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
  const peers = rd("peersview.ts");
  assert.match(peers, /\(ev\.currentTarget as HTMLButtonElement\)\.disabled = true; \/\/ I473/); // Remove in the confirm
  assert.match(peers, /else b\.disabled = true;/); // every other row action
  assert.match(peers, /if \(open\) return open\.focus\(\)/); // one Remove confirm per row
  const page = rd("page.ts");
  assert.match(page, /if \(btn\.disabled\) return;\s+btn\.disabled = true;/); // Remove and continue
  assert.match(rd("popup.ts"), /ready\.catch\(\(e\) => pane\.isConnected && failView\(pane, \(e as Error\)\.message, \(\) => show\(t, prefill\)\)\)/);
});

test("copy: device limit rows read as sentences; desktop says Click; status lines end with a period (I474)", async () => {
  const { limitLine } = await import("../src/ui/page.ts");
  const created = new Date(2026, 9, 2, 12).getTime() / 1000;
  const added = new Date(created * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  assert.equal(limitLine({ id: "x", platform: "android", created, approves: 3, approved_by: 1, reachable: true, logged_out: false }), "Added " + added + ". Trusts 3 devices. Trusted by 1.");
  assert.equal(limitLine({ id: "x", platform: "ios", created, approves: 0, approved_by: 0, reachable: false, logged_out: true }), "Added " + added + ". Trusts 0 devices. Trusted by 0. Unreachable. Logged out.");
  assert.equal(limitLine({ id: "x", platform: "android", created, approves: 1, approved_by: 2, reachable: true, logged_out: false }), "Added " + added + ". Trusts 1 device. Trusted by 2.");
  assert.equal(limitLine({ id: "x", platform: "android", created, approves: 2, approved_by: 0, reachable: true, logged_out: false }), "Added " + added + ". Trusts 2 devices. Trusted by 0.");
  const { T } = await import("../src/core/texts.ts");
  for (const [k, v] of Object.entries(T)) {
    const s = typeof v === "function" ? (v as (x: string) => string)("X") : v;
    assert.doesNotMatch(s, /\bTap\b|\btap\b/, k);
    if (/[.!?] /.test(s)) assert.match(s, /[.!?]$/, k); // a multi-sentence text ends with a period
  }
  assert.equal(T.loginExpired, "Login expired. Log in again.");
  assert.equal(T.notificationsOff, "Notifications are off. This device cannot receive messages.");
});

test("first-device screen: the live read redraws only on a change and keeps focus (I484)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /if \(msg === undefined && focusId === undefined && key === last\) return;/);
  assert.match(pop, /\(same \?\? row \?\? panel\.querySelector<HTMLElement>\("\.fp-title"\)\)\?\.focus\(\);/);
});

test("full tab Send: the cut offer shows only while the text is over 2048 bytes (I485)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /cut\.hidden = !offerCut \|\| d\.bytes <= CAP;/);
});

test("History filter chips keep focus on the pressed chip after the redraw (I486)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /draw\(\);\s*\(chipsBox\.children\[i\] as HTMLElement \| undefined\)\?\.focus\(\);/);
});

test("Rename this device: Enter saves, Esc keeps the old name and focus (I487)", async () => {
  const { readFileSync } = await import("node:fs");
  const pv = readFileSync(new URL("../src/ui/peersview.ts", import.meta.url), "utf8");
  assert.match(pv, /if \(ev\.key === "Enter"\) save\.click\(\);\s*else if \(ev\.key === "Escape"\) show\(nm, true\);/);
});

test("Devices Remove confirm: Esc is Keep and focus goes back to the menu button (I488)", async () => {
  const { readFileSync } = await import("node:fs");
  const pv = readFileSync(new URL("../src/ui/peersview.ts", import.meta.url), "utf8");
  assert.match(pv, /confirm\.addEventListener\("keydown", \(ev\) => \{\s*if \(ev\.key !== "Escape"\) return;\s*ev\.preventDefault\(\);\s*confirm\.querySelector<HTMLElement>\("\.keep"\)\?\.click\(\);/);
  assert.match(pv, /class: "keep", onclick: \(\) => \{ confirm\.remove\(\); b\.focus\(\); \}/);
});

test("Log out error is scrolled into view (I489)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /status\.textContent = \(e as Error\)\.message;\s*status\.scrollIntoView\(\{ block: "nearest" \}\);/);
});

test("Devices Refresh stays grey for its 60 s across a redraw (I490)", async () => {
  const { readFileSync } = await import("node:fs");
  const pv = readFileSync(new URL("../src/ui/peersview.ts", import.meta.url), "utf8");
  assert.match(pv, /if \(refreshUntil > Date\.now\(\)\) greyFor\(refresh, refreshUntil - Date\.now\(\)\);/);
});

test("Devices row with the Remove confirm keeps the icon beside the name (I491)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8"), /\.prow:has\(\.confirm\) > :not\(\.txt\) \{ align-self: start; \}/);
});

test("Send result names the one device; counts read singular for one (I493)", async () => {
  const { T } = await import("../src/core/texts.ts");
  assert.equal(T.sentToNofM(0, 1), "Sent to 0 of 1 device");
  assert.equal(T.sentToNofM(1, 2), "Sent to 1 of 2 devices");
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8"), /one \? T\.sentToOne\(one\.label\) : T\.sentToNofM\(r\.sent, r\.total\)/);
});

test("Send with every device greyed says no device can receive now (I494)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8"), /!sendable\.length && chips\.childElementCount \? h\("p", \{ class: "dim nosend" \}, "No device can receive messages right now\."\)/);
});

test("popup update and log in screens start with focus on their button (I495)", async () => {
  const { readFileSync } = await import("node:fs");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /append\(updateCard\(env\)\);\s*root\.querySelector<HTMLElement>\("button\.primary"\)\?\.focus\(\);/);
  assert.match(pop, /append\(signinCard\(env, st, going, false\)\);\s*root\.querySelector<HTMLElement>\("button\.primary"\)\?\.focus\(\);/);
});

test("full tab History Send to... sets the #send= hash (I497)", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8"), /historyView\(env, root, \(text\) => \(location\.hash = "#send=" \+ encodeURIComponent\(text\)\), arg\)/);
});
