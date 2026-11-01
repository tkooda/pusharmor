// Full extension tab: login, Peers full view, limit picker, over-cap send
// (long flows run in a tab because a popup closes on blur, I029).
import type { LoginResult, Purpose } from "../core/login.ts";
import type { StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, failView, group, h, platformLabel, rpc } from "./dom.ts";
import { AUTH_CHANGED, AUTH_RESULT, clampFrameHeight, emailProblem, readAuthResult, type Restore, formatWait, resendLeftMs, sendLeftMs } from "../model/signin.ts";
import { toast } from "./dialog.ts";
import { appleLogo, googleLogo, icon, platformIcon } from "./icons.ts";
import { renderPeers } from "./peersview.ts";
import { startTheme } from "./theme.ts";
import { historyView, sendView, type Nav, signinCard, updateCard, wordmark } from "./popup.ts";

export const SITE = "https://pusharmor.com";

export async function mountPage(env: UiEnv, root: HTMLElement, hash: string, selfOrigin: string): Promise<void> {
  try {
    await mountRoute(env, root, hash, selfOrigin);
  } catch (e) {
    failView(root, (e as Error).message, () => void mountPage(env, root, hash, selfOrigin));
  }
}

async function mountRoute(env: UiEnv, root: HTMLElement, hash: string, selfOrigin: string): Promise<void> {
  await startTheme(env.theme);
  stopAuthWatch?.();
  stopAuthWatch = null;
  clear(root);
  const [route, arg] = hash.replace(/^#/, "").split("=");
  document.body.classList.toggle("signin-bg", route === "login");
  if ((await rpc<StateView>(env, "state")).updateRequired) {
    root.append(updateCard(env));
    return;
  }
  if (route === "login") return loginView(env, root, arg ?? null, selfOrigin);
  // I465: these views show account data; a login state change loads the tab again
  stopAuthWatch = env.session?.watch(AUTH_CHANGED, () => location.reload()) ?? null;
  const st = await rpc<StateView>(env, "state");
  // I470: the account views need a logged-in device; logged out shows the log in prompt
  if (st.reg !== "registered") {
    const going = (await rpc<Restore | null>(env, "signinProgress").catch(() => null))?.step === "code";
    root.append(signinCard(env, st, going, true));
    return;
  }
  // I500: the brand on top, as in the popup; the view draws below it
  const view = h("div", {});
  root.append(h("div", { class: "head" }, h("img", { src: "icons/icon-32.png", width: "24", height: "24", alt: "" }), wordmark(env, 16)), view);
  const nav: Nav = { toDevices: () => (location.hash = "#pair"), toSend: () => (location.hash = "#send") };
  // I497: Send to... sets the #send= hash (the hashchange mounts it), so a reload keeps the draft
  if (route === "read") return readView(env, root, Number(arg));
  if (route === "history") return historyView(env, view, (text) => (location.hash = "#send=" + encodeURIComponent(text)), arg, nav);
  if (route === "send") {
    let text = "";
    try {
      text = decodeURIComponent(arg ?? "");
    } catch {
      text = "";
    }
    return sendView(env, view, st, text, true, nav);
  }
  // Devices; also a missing or unknown hash
  return renderPeers(env, view, true, route === "peers" ? arg : undefined, undefined, route === "pair");
}

const E2E = "All of your data is always end-to-end encrypted, and can never be read by the server or anyone else.";
const CODE_HELP = "Paste or type the code. Spaces and dashes are fine.";
const ENDS_FLOW = [T.loginExpired, "This code has expired. Get a new code to continue."];

/** One message listener per page (a hash change mounts the view again). */
let onFrameMessage: ((ev: MessageEvent) => void) | null = null;
/** Stops the storage.session watch of the previous view. */
let stopAuthWatch: (() => void) | null = null;

/** Outlined field with a floating label (the label floats while the field has text or focus). */
function field(input: HTMLInputElement, label: string, extra = ""): HTMLElement {
  input.id = "f-" + label.replace(/\W+/g, "-").toLowerCase();
  input.placeholder = " ";
  return h("div", { class: "field" + extra }, input, h("label", { for: input.id }, label));
}

function note(ic: "info" | "history", text: string): HTMLElement {
  return h("div", { class: "note", role: "status" }, icon(ic, 20), h("span", {}, text));
}

/**
 * Help or error text under a field. An error is announced (role alert); when the
 * field is given, it is marked invalid while the error shows. Wire the field to
 * the text once with describe().
 */
function setHelp(el: HTMLElement, text: string, bad: boolean, field?: HTMLElement): void {
  clear(el);
  el.classList.toggle("bad", bad);
  if (bad) el.setAttribute("role", "alert");
  else el.removeAttribute("role");
  if (field) {
    if (bad) field.setAttribute("aria-invalid", "true");
    else field.removeAttribute("aria-invalid");
  }
  if (bad) el.append(icon("error", 18));
  el.append(h("span", {}, text));
  el.hidden = text === "";
}

function describe(field: HTMLElement, help: HTMLElement, id: string): void {
  help.id = id;
  field.setAttribute("aria-describedby", id);
}


async function loginView(env: UiEnv, root: HTMLElement, forced: string | null, selfOrigin: string): Promise<void> {
  const purpose = forced === "delete-account" ? "delete-account" : await rpc<Purpose>(env, "loginPurpose");
  const st = await rpc<StateView>(env, "state");
  const saved = await rpc<Restore | null>(env, "signinProgress", { purpose }).catch(() => null);
  const ff = st.platform === "firefox";

  // Step 1: Google, Apple, or email plus the Turnstile check.
  const email = h("input", { type: "email", autocomplete: "email", spellcheck: "false" }) as HTMLInputElement;
  const emailField = field(email, "Email address");
  const emailHelp = h("p", { class: "help", hidden: true });
  describe(email, emailHelp, "email-help");
  let token = "";
  let tokenUsed = false;
  const newFrame = () =>
    h("iframe", { src: SITE + "/turnstile#o=" + encodeURIComponent(selfOrigin), class: "ts-frame", title: "Security check" }) as HTMLIFrameElement;
  // Turnstile loads only once the email field is used (focus, typing, paste, or autofill), never
  // for Google or Apple; until then an empty slot holds its place.
  let frame: HTMLElement = h("div", { class: "ts-slot", hidden: true });
  let frameLoaded = false;
  /** Resolves a send that waits for the check. */
  let tokenWaiter: (() => void) | null = null;
  const frameHelp = h("p", { class: "help", hidden: true });
  const sendHelp = h("p", { class: "help", hidden: true });
  describe(frame, frameHelp, "frame-help");
  const s1notes = h("div", { class: "notes" });
  // Step 1 shows one note at a time: the banner, the Firefox setup note (only while setup is
  // still needed, with a button that opens it again), or the receive note.
  const setupNote = () => {
    const n = note("info", T.ffFinishSetup);
    n.append(h("button", { type: "button", class: "text", onclick: () => env.openUrl(SITE + "/fx/setup") }, "Open setup"));
    return n;
  };
  // I498: a banner (device removed, keys lost) is the one reason shown; the body does not add "logged out"
  const banner = st.banner && st.banner !== T.signedOut ? st.banner : null;
  const resetNotes = () =>
    add(
      clear(s1notes),
      (banner ? note("info", banner) : null) ??
        (ff && st.setupNeeded ? setupNote() : null) ??
        (st.receiveNote ? note("info", st.receiveNote) : null),
    );
  if (onFrameMessage) window.removeEventListener("message", onFrameMessage);
  onFrameMessage = (ev: MessageEvent) => {
    if (ev.origin !== SITE || ev.source !== (frame as HTMLIFrameElement).contentWindow) return;
    const d = ev.data as { pa?: string; token?: unknown; h?: unknown };
    if (!d) return;
    if (d.pa === "turnstile" && typeof d.token === "string") {
      token = d.token;
      tokenUsed = false;
      tokenWaiter?.();
      setHelp(frameHelp, "", false);
    }
    if (d.pa === "turnstile-size") {
      const px = clampFrameHeight(d.h);
      if (px !== null) frame.style.height = px + "px";
    }
  };
  window.addEventListener("message", onFrameMessage);
  let draftTimer = 0;
  const loadFrame = () => {
    if (frameLoaded) return;
    frameLoaded = true;
    freshFrame();
  };
  email.addEventListener("focus", loadFrame);
  email.addEventListener("input", loadFrame);
  email.addEventListener("input", () => {
    // live: red border while the field holds text that is not a usable address; empty stays normal
    const invalid = email.value.trim() !== "" && emailProblem(email.value) !== "";
    emailField.classList.toggle("bad", invalid);
    setHelp(emailHelp, "", false);
    if (invalid) email.setAttribute("aria-invalid", "true");
    else email.removeAttribute("aria-invalid");
    refreshSend();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void rpc(env, "signinDraft", { email: email.value, purpose }).catch(() => undefined), 300) as unknown as number;
  });
  const sendBtn = h("button", { type: "submit", class: "primary big" }, "Email me a code") as HTMLButtonElement;
  let sentAt = 0;
  let sentTo = "";
  let tick = 0;
  let sending = false;
  // "Email me a code" waits out the resend countdown for the address just sent to.
  const refreshSend = () => {
    clearTimeout(sendTick);
    if (sending) return;
    const left = sendLeftMs(sentAt, sentTo, email.value, Date.now());
    sendBtn.disabled = left > 0;
    sendBtn.setAttribute("aria-disabled", left > 0 ? "true" : "false");
    sendBtn.textContent = left > 0 ? "Email me a code in " + formatWait(left) : "Email me a code";
    if (left > 0) sendTick = setTimeout(refreshSend, ((left - 1) % 1000) + 1) as unknown as number;
  };
  describe(sendBtn, sendHelp, "send-help");
  let sendTick = 0;
  const sendCode = async () => {
    if (sendBtn.disabled && !sending) return;
    setHelp(sendHelp, "", false);
    const v = email.value.trim();
    const bad = emailProblem(v);
    if (bad) {
      emailField.classList.add("bad");
      setHelp(emailHelp, bad, true, email);
      email.focus();
      return;
    }
    if (!token || tokenUsed) {
      // wait for the security check (it may still be loading), with the button saying so
      loadFrame();
      sending = true;
      sendBtn.disabled = true;
      sendBtn.textContent = "Waiting for the security check...";
      const ok = await new Promise<boolean>((done) => {
        tokenWaiter = () => done(true);
        setTimeout(() => done(false), 60_000);
      });
      tokenWaiter = null;
      sending = false;
      refreshSend();
      if (!ok) {
        setHelp(frameHelp, "Finish the check above first.", true);
        return;
      }
    }
    clearTimeout(draftTimer); // a late draft save must not overwrite the step 2 record
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";
    try {
      await rpc(env, "emailStart", { email: v, turnstile: token, purpose });
      tokenUsed = true;
      showCode(v, Date.now(), false);
    } catch (e) {
      tokenUsed = true; // a token is single use: the next try needs a fresh check
      setHelp(sendHelp, (e as Error).message, true);
      freshFrame();
    } finally {
      sending = false;
      refreshSend();
    }
  };
  const freshFrame = () => {
    const f = newFrame();
    f.setAttribute("aria-describedby", "frame-help");
    frame.replaceWith(f);
    frame = f;
    token = "";
  };
  const oauth = (provider: string) => async () => {
    resetNotes();
    try {
      const r = await rpc<LoginResult>(env, "oauth", { provider, purpose });
      // Firefox: this tab goes to Google or Apple and comes back with the result (Q337)
      if (r.url) location.assign(r.url);
      else await done(r);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const title = purpose === "delete-account" ? "Delete account" : "Log in";
  // resuming (logged out) is not a setup: no step counter, and the body says why
  const resuming = purpose === "login";
  const step1 = h(
    "div",
    { class: "step" },
    resuming ? null : h("p", { class: "step-n" }, "Step 1 of 2"),
    h("h1", {}, title),
    h("p", { class: "sub" }, purpose === "delete-account" ? "Log in to the account you want to delete." : resuming && !banner ? "You are logged out. Log in to resume." : "Use the same account on every device you want to pair."),
    resetNotes(),
    h(
      "div",
      { class: "oauth" },
      h("button", { type: "button", class: "big google", onclick: oauth("google") }, googleLogo(), "Continue with Google"),
      h("button", { type: "button", class: "big apple", onclick: oauth("apple") }, appleLogo(), "Continue with Apple"),
    ),
    h("div", { class: "or" }, "or"),
    h(
      "form",
      {
        class: "email-form",
        novalidate: true,
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          void sendCode();
        },
      },
      emailField,
      emailHelp,
      frame,
      frameHelp,
      sendBtn,
      sendHelp,
    ),
  );

  // Step 2: the code from the email.
  const code = h("input", { class: "code", maxlength: "20", autocomplete: "one-time-code", autocapitalize: "characters", spellcheck: "false" }) as HTMLInputElement;
  const codeField = field(code, "6-character code", " code");
  const codeHelp = h("p", { class: "help" });
  describe(code, codeHelp, "code-help");
  const chip = h("span", { class: "who" });
  const s2notes = h("div", { class: "notes" });
  const signBtn = h("button", { type: "submit", class: "primary big" }, "Log in") as HTMLButtonElement;
  const resend = h("button", { type: "button", class: "text" }, "Get a new code") as HTMLButtonElement;
  let busy = false;
  const countdown = () => {
    clearTimeout(tick);
    const left = resendLeftMs(sentAt, Date.now());
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? "Get a new code in " + formatWait(left) : "Get a new code";
    if (left > 0 && !step2.hidden) tick = setTimeout(countdown, ((left - 1) % 1000) + 1) as unknown as number;
  };
  const verify = async () => {
    if (busy) return;
    busy = true;
    signBtn.disabled = true;
    try {
      await done(await rpc<LoginResult>(env, "emailVerify", { code: code.value }));
    } catch (e) {
      const msg = (e as Error).message;
      if (ENDS_FLOW.includes(msg)) {
        showEmail(email.value);
        toast(msg, "err");
      } else {
        codeField.classList.add("bad");
        setHelp(codeHelp, msg === "Enter the 6-character code" ? "Enter the 6-character code from the email." : msg, true, code);
      }
    } finally {
      busy = false;
      signBtn.disabled = false;
    }
  };
  code.addEventListener("input", () => {
    codeField.classList.remove("bad");
    setHelp(codeHelp, CODE_HELP, false, code);
    const cleaned = code.value.replace(/[\s-]/g, "");
    if (cleaned.length === 6) void verify();
  });
  code.addEventListener("paste", (ev: ClipboardEvent) => {
    const text = ev.clipboardData?.getData("text") ?? "";
    const m = /(?:^|[^0-9A-Za-z])([0-9A-Za-z](?:[ -]?[0-9A-Za-z]){5})(?![0-9A-Za-z])/.exec(text.trim());
    if (m) {
      ev.preventDefault();
      code.value = m[1]!;
      void verify();
    }
  });
  const back = h("button", { type: "button", class: "back", "aria-label": "Back", hidden: true, onclick: () => showEmail(email.value) }, icon("back", 24));
  const step2 = h(
    "div",
    { class: "step", hidden: true },
    resuming ? null : h("p", { class: "step-n" }, "Step 2 of 2"),
    h("h1", {}, "Check your email"),
    h("div", { class: "center" }, chip),
    h("p", { class: "sub" }, "We sent a 6-character code to this address. It can take a minute to arrive."),
    s2notes,
    h(
      "form",
      {
        class: "code-form",
        novalidate: true,
        onsubmit: (ev: Event) => {
          ev.preventDefault();
          void verify();
        },
      },
      codeField,
      codeHelp,
      signBtn,
    ),
    h(
      "div",
      { class: "links" },
      h("button", {
        type: "button",
        class: "text",
        onclick: () => {
          void rpc(env, "signinClear").catch(() => undefined);
          showEmail("");
        },
      }, "Use a different email"),
      resend,
    ),
  );
  resend.addEventListener("click", () => {
    showEmail(email.value);
    loadFrame();
    frame.focus();
  });

  const card = h("div", { class: "l-card" }, back, h("div", { class: "l-brand" }, wordmark(env, 24)), step1, step2);
  const showEmail = (value: string) => {
    clearTimeout(tick);
    email.value = value;
    refreshSend();
    step1.hidden = false;
    step2.hidden = true;
    back.hidden = true;
    resetNotes();
    if (frameLoaded && (tokenUsed || !token)) freshFrame(); // a used token, or a frame first loaded while hidden
    if (!value) email.focus();
  };
  const showCode = (addr: string, at: number, restored: boolean) => {
    email.value = addr;
    sentAt = at;
    sentTo = addr.trim().toLowerCase();
    clear(chip).append(h("span", { class: "ava" }, (addr.charAt(0) || "?").toUpperCase()), h("span", { class: "addr" }, addr));
    clear(s2notes);
    if (restored) {
      const t = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      s2notes.append(note("history", "Welcome back. You can pick up where you left off: the code we sent at " + t + " still works."));
    }
    code.value = "";
    codeField.classList.remove("bad");
    setHelp(codeHelp, CODE_HELP, false, code);
    step1.hidden = true;
    step2.hidden = false;
    back.hidden = false;
    countdown();
    code.focus();
  };
  const done = async (r: LoginResult) => {
    if (r.limit) return limitView(env, root, r.limit, r.ticket ?? "");
    if (r.done) {
      clearTimeout(tick);
      doneCard(env, clear(card), purpose === "delete-account");
    }
  };

  add(root, h("div", { class: "login" }, card, h("p", { class: "e2e" }, icon("lock", 20), h("span", {}, E2E))));
  // Firefox: Google or Apple finishes in the background (authDone), which leaves the result in storage.session.
  const session = env.session;
  if (ff && session) {
    const take = async (v: unknown) => {
      const r = readAuthResult(v, Date.now());
      if (!r) return;
      await session.remove(AUTH_RESULT);
      if (r.error) toast(r.error, "err");
      else await done(r);
    };
    stopAuthWatch = session.watch(AUTH_RESULT, (v) => void take(v));
    void session.get(AUTH_RESULT).then(take);
  }
  if (saved && saved.step === "code") showCode(saved.email, saved.sentAt, true);
  else if (saved) {
    email.value = saved.email;
    sentAt = saved.sentAt;
    sentTo = saved.email.trim().toLowerCase();
    refreshSend();
    if (saved.note === "expired") s1notes.prepend(note("history", "Your last code has expired. Get a new code to continue."));
  }
}

export interface LimitPeer {
  id: string;
  platform: string;
  created: number;
  approves: number;
  approved_by: number;
  reachable: boolean;
  logged_out: boolean;
}

const devices = (n: number): string => n + (n === 1 ? " device" : " devices");

/** Device limit row, second line: "Added Oct 2, 2026. Trusts 3 devices. Trusted by 1. Unreachable." */
export function limitLine(p: LimitPeer): string {
  const added = new Date(p.created * 1000).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  return ["Added " + added + ".", "Trusts " + devices(p.approves) + ".", "Trusted by " + p.approved_by + ".", p.reachable ? "" : "Unreachable.", p.logged_out ? "Logged out." : ""]
    .filter(Boolean)
    .join(" ");
}

/** The login result card; focus goes to its heading (the old controls are gone: read the result). */
function doneCard(env: UiEnv, card: HTMLElement, deleted: boolean): void {
  const heading = h("h1", { tabindex: "-1" }, deleted ? "Account deleted" : "You are logged in");
  card.append(
    h("div", { class: "l-brand" }, wordmark(env, 24)),
    h(
      "div",
      { class: "step done" },
      h("div", { class: "ok" }, icon("check", 32)),
      heading,
      h("p", { class: "sub" }, "You can close this tab."),
      h("button", { type: "button", class: "big", onclick: () => window.close() }, "Close tab"),
    ),
  );
  heading.focus();
}

function limitView(env: UiEnv, root: HTMLElement, body: Record<string, unknown>, ticket: string): void {
  clear(root);
  document.body.classList.remove("signin-bg");
  const peers = (Array.isArray(body.peers) ? body.peers : []) as LimitPeer[];
  const boxes: { id: string; box: HTMLInputElement }[] = [];
  const list = group();
  const heading = h("h1", { tabindex: "-1" }, "Device limit reached");
  root.append(heading, h("div", { class: "lead" }, "Pick devices to remove from this account, then continue."));
  for (const p of peers) {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement; // nothing pre-ticked
    boxes.push({ id: p.id, box });
    list.append(
      h(
        "label",
        { class: "prow target" },
        h("div", { class: "av" }, platformIcon(p.platform)),
        h("div", { class: "txt" }, h("div", { class: "t1" }, platformLabel(p.platform)), h("div", { class: "t2" }, limitLine(p))),
        box,
      ),
    );
  }
  root.append(
    list,
    h(
      "div",
      { class: "btns" },
      h("button", { onclick: () => window.close() }, "Cancel"),
      h("button", {
        class: "primary",
        onclick: async (ev: Event) => {
          const btn = ev.currentTarget as HTMLButtonElement;
          if (btn.disabled) return;
          btn.disabled = true; // I473: the ticket is single use; a second request would fail
          const evict = boxes.filter((b) => b.box.checked).map((b) => b.id);
          try {
            const r = await rpc<LoginResult>(env, "evict", { ticket, evict });
            if (r.done) {
              // I501: the same done card as a login without the limit
              document.body.classList.add("signin-bg");
              const card = h("div", { class: "l-card" });
              clear(root).append(h("div", { class: "login" }, card));
              doneCard(env, card, false);
            } else if (r.limit) limitView(env, root, r.limit, r.ticket ?? ticket);
          } catch (e) {
            toast((e as Error).message, "err");
            if ((e as Error).message === T.loginExpired) env.openPage("#login");
          } finally {
            btn.disabled = false;
          }
        },
      }, "Remove and continue"),
    ),
  );
  heading.focus();
}

/** I622: the whole message in a full tab, selectable, with only a close X at the top right. */
async function readView(env: UiEnv, root: HTMLElement, id: number): Promise<void> {
  const row = (await rpc<{ id?: number; content: string }[]>(env, "history")).find((r) => r.id === id);
  clear(root);
  const close = () => {
    window.close();
    // a tab the user opened by hand cannot close itself
    location.hash = "#history";
  };
  root.append(
    h("div", { class: "readview" },
      h("button", { type: "button", class: "quiet ib readx", "aria-label": "Close", title: "Close", onclick: close }, icon("close", 22)),
      h("div", { class: "readtext", tabindex: "0" }, row?.content ?? "")),
  );
}
