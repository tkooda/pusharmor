// Store screenshots of the Chrome popup (dev builds only: build.mjs --dev --shots, run by
// shots.mjs). Mounts the real popup with canned replies: no engine, no keys, no Worker
// call. check-release.mjs fails a release zip that holds the marker below.
import type { PeerView, Reply, Req, StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { DEFAULT_SETTINGS } from "../core/engine.ts";
import { PAIRING_TIMEOUT_DAYS, formatCountdown } from "../model/countdown.ts";
import { detectType } from "../model/detect.ts";
import { utf8Len } from "../model/padding.ts";
import type { HistoryRow } from "../store/db.ts";
import type { UiEnv } from "../ui/dom.ts";
import { memoryThemeStore } from "../ui/theme.ts";
import { mountPopup } from "../ui/popup.ts";

export const MARKER = "PA_SCREENSHOTS";

const id = (c: string): string => c.repeat(40);
const PHONE = id("P");
const DESKTOP = id("W");
const TABLET = id("T");
const NEW_LAPTOP = id("N");
const now = Date.now();

// ?platform=firefox: the popup runs on Firefox (this device, and the new laptop); the
// work desktop is then the Chrome one. Default: the Chrome set.
const q = new URLSearchParams(location.search);
const THIS = q.get("platform") === "firefox" ? "firefox" : "chrome";
const OTHER = THIS === "firefox" ? "chrome" : "firefox";

const state: StateView = {
  reg: "registered", banner: null, email: null, name: "Laptop", settings: DEFAULT_SETTINGS,
  platform: THIS, isAndroid: false, receiveMode: null, receiveNote: null, setupNeeded: false, updateRequired: false, recheckLocked: false, pushIssue: null, keysBroken: false, version: "0.0.0",
};

const paired = (pid: string, label: string, platform: string, greyed: string | null = null): PeerView => ({
  id: pid, label, platform, lines: [], actions: ["remove"], countdown: null, fingerprint: null, pk: null,
  greyed, hidden: false, sendable: true, approvesMe: true, paired: true,
});

const peers: PeerView[] = [
  paired(PHONE, "Phone", "android"),
  paired(DESKTOP, "Work desktop", OTHER),
  paired(TABLET, "Tablet", "android", "unreachable"),
  {
    id: NEW_LAPTOP, label: "New laptop", platform: THIS, lines: [T.fingerprint("K7QD")],
    actions: ["cancel", "approve", "deny", "remove"], countdown: formatCountdown(PAIRING_TIMEOUT_DAYS * 86400e3 - 60_000),
    fingerprint: "K7QD", pk: null, greyed: null, hidden: false, sendable: false, approvesMe: false, paired: false,
  },
];

// ?n=0|1|3|9: that many other devices on the Send tab (some selected); default: the store set above.
// ?n=0 also empties History (the empty states).
const MORE: [string, string][] = [["iPad", "ios"], ["Home PC", "chrome"], ["MacBook", "chrome"], ["Kitchen tablet", "android"], ["Office laptop", "firefox"], ["Spare phone", "android"]];
let sendSel: string[] = [];
if (q.has("n")) {
  const n = Number(q.get("n"));
  const base = [paired(PHONE, "Phone", "android"), paired(DESKTOP, "Work desktop", OTHER), paired(TABLET, "Tablet", "android")];
  const more = MORE.map(([label, platform], i) => paired(id(String(i)), label, platform, label === "Kitchen tablet" ? "unreachable" : null));
  peers.splice(0, peers.length, ...[...base, ...more].slice(0, n));
  sendSel = n === 1 ? [] : n === 3 ? [PHONE, DESKTOP] : [PHONE, DESKTOP, id("0"), id("1"), id("2"), id("5")];
}

const history: (HistoryRow & { sender: string })[] = [
  { id: 5, dir: "in", peer: PHONE, type: "url", content: "https://www.example.com/recipes/2026/10/weeknight-lemon-pasta", n: 1, pairing_id: null,
    received: now - 2 * 60_000, read: false, sender: "Phone" },
  { id: 4, dir: "in", peer: DESKTOP, type: "text", content: "Meeting moved to 3 pm, room B", n: 1, pairing_id: null,
    received: now - 25 * 60_000, read: true, sender: "Work desktop" },
  { id: 3, dir: "out", peer: null, type: "url", content: "https://example.com/guide/hiking-trails", n: null, pairing_id: null,
    received: now - 40 * 60_000, read: true, results: { [TABLET]: "sent" }, targets: [TABLET], sender: "Tablet" },
  { id: 2, dir: "in", peer: TABLET, type: "event", event: "logged_out", content: "", n: null, pairing_id: null,
    received: now - 50 * 60_000, read: true, sender: "Tablet" },
  { id: 1, dir: "in", peer: PHONE, type: "text", content: "Pick up basil and lemons on the way home", n: 1, pairing_id: null,
    received: now - 26 * 3600_000, read: true, sender: "Phone" },
];

if (q.get("n") === "0") history.length = 0;
// ?wait (with n=0): one device logged in on the account and waiting to pair
if (q.has("wait")) {
  peers.push({ id: id("W"), label: "Phone", platform: "android", lines: [], actions: ["pair", "deny", "remove"], countdown: null,
    fingerprint: null, pk: null, greyed: null, hidden: false, sendable: false, approvesMe: false, paired: false });
}

// ?only=new: just the pairing-code device (first-pair screen with the fingerprint)
if (q.get("only") === "new") peers.splice(0, peers.length, { ...peers.find((p) => p.id === NEW_LAPTOP)!, countdown: "4:12" });
// ?long: long device names with no spaces (narrow screen check)
if (q.has("long")) {
  const long = "KitchenTabletOnTheCounterNextToTheWindow";
  for (const p of peers) if (p.id === TABLET || p.id === NEW_LAPTOP) p.label = long;
}
// ?senderr: Phone is selected and Send fails (the relay server cannot be reached)
if (q.has("senderr")) sendSel = [PHONE];

// ?store: History rows show Share (as in a browser that has it)
if (q.has("store") && !navigator.share) Object.defineProperty(navigator, "share", { value: async () => undefined, configurable: true });
// ?store: the store screenshot sample data (the same as the iOS and Android store shots); this device is Work laptop.
// With ?wait only Galaxy S23 waits to pair; with ?only=new it shows the fingerprint R4NX.
if (q.has("store")) {
  const G = id("G"), H = id("H"), I = id("I"), X = id("X");
  state.name = "Work laptop";
  const mk = (pid: string, label: string, platform: string): PeerView => paired(pid, label, platform);
  peers.splice(0, peers.length, mk(G, "Galaxy S23", "android"), mk(H, "Home PC", "firefox"), mk(I, "iPhone 15", "ios"), mk(X, "Pixel 8", "android"));
  sendSel = [X];
  if (q.has("wait")) {
    peers.splice(0, peers.length, { id: G, label: "Galaxy S23", platform: "android", lines: [], actions: ["pair", "deny", "remove"], countdown: null,
      fingerprint: null, pk: null, greyed: null, hidden: false, sendable: false, approvesMe: false, paired: false } as PeerView);
  }
  if (q.get("only") === "new") {
    peers.splice(0, peers.length, { id: G, label: "Galaxy S23", platform: "android", lines: [T.fingerprint("R4NX")],
      actions: ["cancel", "approve", "deny", "remove"], countdown: "4:12",
      fingerprint: "R4NX", pk: null, greyed: null, hidden: false, sendable: false, approvesMe: false, paired: false } as PeerView);
  }
  const m = 60_000;
  history.splice(0, history.length,
    { id: 6, dir: "in", peer: I, type: "url", content: "https://www.wikipedia.org/wiki/Union_Station_(Chicago)", n: 1, pairing_id: null, received: now - 2 * m, read: true, sender: "iPhone 15" },
    { id: 5, dir: "in", peer: X, type: "text", content: "Notes from the trip: the cabin key is under the blue flowerpot by the back door, and the spare blankets are in the hall closet. The heater needs a few minutes to warm up.", n: 1, pairing_id: null, received: now - 9 * m, read: true, sender: "Pixel 8" },
    { id: 4, dir: "in", peer: X, type: "text", content: "Door code is 4821", n: 1, pairing_id: null, received: now - 27 * m, read: true, sender: "Pixel 8" },
    { id: 3, dir: "out", peer: null, type: "url", content: "https://github.com/tkooda/pusharmor", n: null, pairing_id: null, received: now - 74 * m, read: true, results: { [H]: "sent" }, targets: [H], sender: "Home PC" },
    { id: 2, dir: "in", peer: H, type: "text", content: "Pick up milk and eggs on the way home", n: 1, pairing_id: null, received: now - 239 * m, read: true, sender: "Home PC" },
    { id: 1, dir: "in", peer: G, type: "text", content: "Meeting moved to 3:30 pm", n: 1, pairing_id: null, received: now - 30 * 3600_000, read: true, sender: "Galaxy S23" },
  );
}

function reply(req: Req): unknown {
  const text = String(req.args?.text ?? "");
  switch (req.op) {
    case "popupOpen":
    case "state":
      return state;
    case "peers":
      return { self: { id: id("C"), name: state.name }, peers };
    case "history":
      return history;
    case "signout":
      state.reg = "logged_out";
      return null;
    case "send":
      if (q.has("senderr")) throw new Error("Unable to send.\nThe relay server could not be reached. Check your internet connection and try again.");
      return { sent: 2, total: 2, failures: [] };
    case "sendSel":
      return sendSel;
    case "detect":
      return { type: detectType(text), bytes: utf8Len(text) };
    default:
      return null;
  }
}

const env: UiEnv = {
  call: async (req: Req): Promise<Reply> => {
    try {
      return { ok: true, data: reply(req) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  activeUrl: async () => (q.has("store") ? "https://www.nasa.gov/image-of-the-day/" : "https://example.com/guide/hiking-trails"),
  openPage: () => undefined,
  openUrl: () => undefined,
  saveFile: async () => null,
  copy: async () => undefined,
  beta: false,
  // ?full: popup.html shown full screen (Firefox for Android); ?tab: the full tab view
  inPopup: () => !q.has("full") && !q.has("tab"),
  theme: memoryThemeStore(new URLSearchParams(location.search).get("theme")),
};

const HEADLINES: Record<string, string> = {
  send: "Send the page you are on to your phone in one click.",
  peers: "Pair your devices with a four-character fingerprint.",
  history: "Send URLs or text to your devices, end-to-end encrypted.",
};

async function main(): Promise<void> {
  document.documentElement.dataset.mode = MARKER;
  // ?bare: the popup alone at its real size (no store frame)
  if (q.has("bare")) document.documentElement.classList.add("bare");
  if (q.has("full")) document.documentElement.classList.add("full");
  if (q.has("tab")) document.documentElement.classList.add("tab");
  // ?zoom=2: lay the popup out at twice the size (headless Firefox screenshots ignore the pixel ratio)
  if (q.has("zoom")) document.documentElement.style.zoom = q.get("zoom")!;
  const tab = location.hash.slice(1) || "send";
  if (tab === "signin") state.reg = null;
  // review images (shots.mjs --review): Settings with an account, and after Log out
  if (tab === "settings" || tab === "signout") state.email = "sam@example.com";
  document.getElementById("headline")!.textContent = HEADLINES[tab] ?? "";
  await mountPopup(env, document.getElementById("app")!);
  // let the first view finish drawing before switching tabs
  await new Promise((done) => setTimeout(done, 500));
  const open = tab === "signout" ? "settings" : tab;
  const btn = document.querySelector('[data-tab="' + open + '"]') as HTMLElement | null;
  if (!btn?.classList.contains("on")) btn?.click();
  if (q.has("senderr")) {
    document.querySelector<HTMLElement>(".send-foot button.primary")?.click();
    await new Promise((done) => setTimeout(done, 300));
  }
  // ?sendok: Send succeeds (the message at the bottom); late, so the 2 s message is still up for the screenshot
  if (q.has("sendok")) {
    await new Promise((done) => setTimeout(done, 1700));
    document.querySelector<HTMLElement>(".send-foot button.primary")?.click();
    await new Promise((done) => setTimeout(done, 300));
  }
  // ?confirm: the Remove confirm of the first device (from its overflow menu)
  if (q.has("confirm")) {
    await new Promise((done) => setTimeout(done, 500));
    document.querySelector<HTMLElement>(".prow .more button")?.click();
    [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((b) => b.textContent === "Remove device from account")?.click();
    await new Promise((done) => setTimeout(done, 300));
  }
  // ?menu=last: the overflow menu of the last device row, scrolled to the bottom of the list
  if (q.get("menu") === "last") {
    await new Promise((done) => setTimeout(done, 500));
    const pn = document.getElementById("panel")!;
    pn.scrollTop = pn.scrollHeight;
    [...document.querySelectorAll<HTMLElement>(".prow .more button")].pop()?.click();
    await new Promise((done) => setTimeout(done, 300));
  }
  // ?open: the newest History row is opened (its actions show)
  if (q.has("open")) {
    await new Promise((done) => setTimeout(done, 500));
    document.querySelector<HTMLElement>(".hrow")?.click();
    await new Promise((done) => setTimeout(done, 300));
  }
  // ?store&only=new: the pairing card scrolled into view (?tab: from its fingerprint plate down);
  // ?store&tab&wait: the waiting device scrolled into view
  if (q.has("store") && (q.get("only") === "new" || (q.has("tab") && q.has("wait")))) {
    await new Promise((done) => setTimeout(done, 500));
    const pn = document.getElementById("panel")!;
    const plate = pn.querySelector(".plate");
    pn.scrollTop = q.has("tab") && plate ? pn.scrollTop + plate.getBoundingClientRect().top - pn.getBoundingClientRect().top - 12 : pn.scrollHeight;
  }
  if ((tab === "settings" || tab === "signout") && !q.has("top")) {
    await new Promise((done) => setTimeout(done, 500));
    // the Log out and Delete account buttons sit at the bottom of the Settings tab
    if (tab === "signout") {
      [...document.querySelectorAll("button")].filter((b) => b.textContent === "Log out").pop()?.click();
      await new Promise((done) => setTimeout(done, 300));
    }
    await new Promise((done) => setTimeout(done, 300));
    const pn = document.getElementById("panel")!;
    pn.scrollTop = pn.scrollHeight;
  }
  // store frame: scale the popup (layout zoom, so text stays sharp) to the height under the
  // 96px band
  if (!q.has("bare")) {
    await new Promise((done) => setTimeout(done, 300));
    const frame = document.querySelector<HTMLElement>(".frame")!;
    frame.style.zoom = "1";
    const h = frame.offsetHeight;
    frame.style.zoom = String(Math.min((800 - 96 - 16) / h, 1280 / 400));
    // middle-ellipsis links were fitted at zoom 1; fit them again at the new zoom
    dispatchEvent(new Event("resize"));
    // the zoom changed the scroll height: keep the Settings bottom (Account card) in view
    const pn = document.getElementById("panel");
    if (pn && (tab === "settings" || tab === "signout")) pn.scrollTop = pn.scrollHeight;
  }
}

void main();
