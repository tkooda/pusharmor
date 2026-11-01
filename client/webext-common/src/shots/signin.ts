// Sign-in screenshots (dev builds only: build.mjs --dev --shots). Mounts the real popup
// welcome card or the real sign-in tab with canned replies: no engine, no Worker call.
//   signin.html#popup | #popup-continue | #email | #check | #code | #restored | #expired | #error
//   ?ff         Firefox platform (tokens come from the build, so pair it with the Firefox dist)
//   ?ts=<url>   load this URL in the Turnstile frame (a local copy of site/public/turnstile.html)
//   ?bounds     outline the Turnstile frame (the widget does not load in headless Chrome)
//   ?resume     a logged-out device logging in again; ?setup the Firefox setup note
import type { Reply, Req, StateView } from "../core/rpc.ts";
import { DEFAULT_SETTINGS } from "../core/engine.ts";
import type { Restore } from "../model/signin.ts";
import type { UiEnv } from "../ui/dom.ts";
import { memoryThemeStore } from "../ui/theme.ts";
import { SITE, mountPage } from "../ui/page.ts";
import { mountPopup } from "../ui/popup.ts";

export const MARKER = "PA_SCREENSHOTS";

const shot = location.hash.slice(1) || "email";
const q = new URLSearchParams(location.search);
const now = Date.now();
const EMAIL = "sam@example.com";

const state: StateView = {
  reg: null, banner: null, email: null, name: "Laptop", settings: DEFAULT_SETTINGS,
  platform: q.has("ff") ? "firefox" : "chrome", isAndroid: false, receiveMode: null, receiveNote: null, setupNeeded: q.has("setup"), updateRequired: q.has("update"),
};

function progress(): Restore | null {
  if (shot === "restored" || shot === "popup-continue") return { step: "code", email: EMAIL, note: "restored", sentAt: now - 3 * 60_000 };
  if (shot === "expired") return { step: "email", email: EMAIL, note: "expired", sentAt: now - 20 * 60_000 };
  return null;
}

function reply(req: Req): Reply {
  switch (req.op) {
    case "popupOpen":
    case "state":
      return { ok: true, data: state };
    case "loginPurpose":
      return { ok: true, data: q.has("resume") ? "login" : "register" };
    case "signinProgress":
      return { ok: true, data: progress() };
    case "emailVerify":
      return { ok: false, error: "That code did not work. Check the newest email from PushArmor and try again." };
    default:
      return { ok: true, data: null };
  }
}

const env: UiEnv = {
  call: async (req: Req): Promise<Reply> => reply(req),
  activeUrl: async () => "",
  openPage: () => undefined,
  openUrl: () => undefined,
  saveFile: async () => null,
  copy: async () => undefined,
  beta: true,
  theme: memoryThemeStore(new URLSearchParams(location.search).get("theme")),
};

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The message the Turnstile page posts, as if it came from the site frame. */
function fromFrame(data: unknown): void {
  const frame = document.querySelector<HTMLIFrameElement>("iframe.ts-frame")!;
  window.dispatchEvent(new MessageEvent("message", { origin: SITE, source: frame.contentWindow, data }));
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

async function main(): Promise<void> {
  document.documentElement.dataset.mode = MARKER;
  const app = document.getElementById("app")!;
  if (shot.startsWith("popup")) {
    document.documentElement.classList.add("shot-popup");
    document.body.classList.remove("page");
    await mountPopup(env, app);
    return;
  }
  const ts = q.get("ts");
  if (ts) {
    // the Turnstile frame loads the local page from the start (no visit to the live site)
    const set = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (this: Element, k: string, v: string) {
      set.call(this, k, k === "src" && this.tagName === "IFRAME" && v.startsWith(SITE + "/turnstile") ? ts : v);
    };
  }
  await mountPage(env, app, "#login", "chrome-extension://" + "a".repeat(32));
  if (q.has("bounds")) document.documentElement.classList.add("bounds");
  const email = document.querySelector<HTMLInputElement>("input[type=email]")!;
  if (shot === "email" || shot === "check" || shot === "code" || shot === "error") type(email, EMAIL);
  if (shot === "check") document.querySelector<HTMLButtonElement>(".email-form button.primary")!.click();
  if (shot === "code" || shot === "error") {
    fromFrame({ pa: "turnstile", token: "shot-token" });
    fromFrame({ pa: "turnstile-size", h: 65 });
    document.querySelector<HTMLButtonElement>(".email-form button.primary")!.click();
    await wait(50);
  }
  if (shot === "error") {
    type(document.querySelector<HTMLInputElement>("input.code")!, "K7Q2PX");
    await wait(50);
  }
  if (shot === "email") email.focus();
}

void main();
