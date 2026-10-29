// Store screenshots of the Chrome popup (dev builds only: build.mjs --dev --shots, run by
// shots.mjs). Mounts the real popup with canned replies: no engine, no keys, no Worker
// call. check-release.mjs fails a release zip that holds the marker below.
import type { PeerView, Reply, Req, StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { DEFAULT_SETTINGS } from "../core/engine.ts";
import { PAIRING_TIMEOUT_MS, formatCountdown } from "../model/countdown.ts";
import { detectType } from "../model/detect.ts";
import { utf8Len } from "../model/padding.ts";
import type { HistoryRow } from "../store/db.ts";
import type { UiEnv } from "../ui/dom.ts";
import { mountPopup } from "../ui/popup.ts";

export const MARKER = "PA_SCREENSHOTS";

const id = (c: string): string => c.repeat(40);
const PHONE = id("P");
const DESKTOP = id("W");
const TABLET = id("T");
const NEW_LAPTOP = id("N");
const now = Date.now();

const state: StateView = {
  reg: "registered", banner: null, email: null, name: "Laptop", settings: DEFAULT_SETTINGS,
  platform: "chrome", isAndroid: false, receiveMode: null, receiveNote: null,
};

const paired = (pid: string, label: string, platform: string, greyed: string | null = null): PeerView => ({
  id: pid, label, platform, lines: [], actions: ["remove", "hide"], countdown: null, fingerprint: null, pk: null,
  greyed, hidden: false, sendable: true, approvesMe: true,
});

const peers: PeerView[] = [
  paired(PHONE, "Phone", "android"),
  paired(DESKTOP, "Work desktop", "firefox"),
  paired(TABLET, "Tablet", "android", "unreachable"),
  {
    id: NEW_LAPTOP, label: "New laptop", platform: "chrome", lines: [T.fingerprint("K7QD")],
    actions: ["cancel", "approve", "deny", "remove", "hide"], countdown: formatCountdown(PAIRING_TIMEOUT_MS - 60_000),
    fingerprint: "K7QD", pk: null, greyed: null, hidden: false, sendable: false, approvesMe: false,
  },
];

const history: (HistoryRow & { sender: string })[] = [
  { id: 5, dir: "in", peer: PHONE, type: "url", content: "https://www.example.com/recipes/2026/10/weeknight-lemon-pasta", n: 1, pairing_id: null,
    received: now - 2 * 60_000, read: false, sender: "Phone" },
  { id: 4, dir: "in", peer: DESKTOP, type: "text", content: "Meeting moved to 3 pm, room B", n: 1, pairing_id: null,
    received: now - 25 * 60_000, read: true, sender: "Work desktop" },
  { id: 3, dir: "out", peer: null, type: "url", content: "https://example.com/guide/hiking-trails", n: null, pairing_id: null,
    received: now - 40 * 60_000, read: true, results: { [TABLET]: "sent" }, targets: [TABLET], sender: "" },
  { id: 2, dir: "in", peer: TABLET, type: "event", event: "paused", content: "", n: null, pairing_id: null,
    received: now - 50 * 60_000, read: true, sender: "Tablet" },
  { id: 1, dir: "in", peer: PHONE, type: "text", content: "Pick up basil and lemons on the way home", n: 1, pairing_id: null,
    received: now - 26 * 3600_000, read: true, sender: "Phone" },
];

function reply(req: Req): unknown {
  const text = String(req.args?.text ?? "");
  switch (req.op) {
    case "popupOpen":
    case "state":
      return state;
    case "peers":
      return { self: { id: id("C"), name: "Laptop" }, peers };
    case "history":
      return history;
    case "detect":
      return { type: detectType(text), bytes: utf8Len(text) };
    default:
      return null;
  }
}

const env: UiEnv = {
  call: async (req: Req): Promise<Reply> => ({ ok: true, data: reply(req) }),
  activeUrl: async () => "https://example.com/guide/hiking-trails",
  openPage: () => undefined,
  openUrl: () => undefined,
  copy: async () => undefined,
  beta: false,
};

const HEADLINES: Record<string, string> = {
  send: "Send the page you are on to your phone in one click.",
  peers: "Pair your devices with a four-character fingerprint.",
  history: "Links and text from your devices, end to end encrypted.",
};

async function main(): Promise<void> {
  document.documentElement.dataset.mode = MARKER;
  const tab = location.hash.slice(1) || "send";
  if (tab === "signin") state.reg = null;
  document.getElementById("headline")!.textContent = HEADLINES[tab] ?? "";
  await mountPopup(env, document.getElementById("app")!);
  // let the first (Send) view finish drawing before switching tabs
  await new Promise((done) => setTimeout(done, 500));
  if (tab !== "send") (document.querySelector('[data-tab="' + tab + '"]') as HTMLElement | null)?.click();
}

void main();
