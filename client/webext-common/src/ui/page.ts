// Full extension tab: login, Peers full view, limit picker, over-cap send
// (long flows run in a tab because a popup closes on blur, I029).
import type { LoginResult, Purpose } from "../core/login.ts";
import type { StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, failView, group, h, rpc } from "./dom.ts";
import { clampFrameHeight, type Restore, resendLeftMs } from "../model/signin.ts";
import { appleLogo, googleLogo, icon, platformIcon } from "./icons.ts";
import { renderPeers } from "./peersview.ts";
import { startTheme } from "./theme.ts";
import { historyView, sendView, wordmark } from "./popup.ts";

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
  clear(root);
  const [route, arg] = hash.replace(/^#/, "").split("=");
  document.body.classList.toggle("signin-bg", route === "login");
  if (route === "login") return loginView(env, root, arg ?? null, selfOrigin);
  if (route === "peers") return renderPeers(env, root, true, arg);
  if (route === "history") return historyView(env, root, (text) => void mountPage(env, root, "#send=" + encodeURIComponent(text), selfOrigin), arg);
  if (route === "send") {
    const st = await rpc<StateView>(env, "state");
    let text = "";
    try {
      text = decodeURIComponent(arg ?? "");
    } catch {
      text = "";
    }
    return sendView(env, root, st, text, true);
  }
  root.append(h("div", {}, "PushArmor"));
}

const E2E = "All of your data is always end-to-end encrypted, and can never be read by the server or anyone else.";
const CODE_HELP = "Paste or type the code. Spaces and dashes are fine.";
const ENDS_FLOW = ["Sign-in expired, sign in again", "This code has expired. Get a new code to continue."];

/** One message listener per page (a hash change mounts the view again). */
let onFrameMessage: ((ev: MessageEvent) => void) | null = null;

/** Outlined field with a floating label (the label floats while the field has text or focus). */
function field(input: HTMLInputElement, label: string, extra = ""): HTMLElement {
  input.id = "f-" + label.replace(/\W+/g, "-").toLowerCase();
  input.placeholder = " ";
  return h("div", { class: "field" + extra }, input, h("label", { for: input.id }, label));
}

function note(kind: "" | "err", ic: "info" | "history" | "error", text: string): HTMLElement {
  return h("div", { class: "note" + (kind ? " " + kind : ""), role: kind ? "alert" : "status" }, icon(ic, 20), h("span", {}, text));
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

const clock = (ms: number): string => Math.floor(ms / 60_000) + ":" + String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");

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
  let frame = newFrame();
  const frameHelp = h("p", { class: "help", hidden: true });
  const sendHelp = h("p", { class: "help", hidden: true });
  describe(frame, frameHelp, "frame-help");
  const s1notes = h("div", { class: "notes" });
  // Step 1 notes: an optional new note first, then the lasting ones (banner, Firefox setup, receive note).
  const resetNotes = (first?: HTMLElement) =>
    add(
      clear(s1notes),
      first,
      st.banner && st.banner !== title ? note("", "info", st.banner) : null,
      ff && !st.reg ? note("", "info", T.ffFinishSetup) : null,
      st.receiveNote ? note("", "info", st.receiveNote) : null,
    );
  if (onFrameMessage) window.removeEventListener("message", onFrameMessage);
  onFrameMessage = (ev: MessageEvent) => {
    if (ev.origin !== SITE || ev.source !== frame.contentWindow) return;
    const d = ev.data as { pa?: string; token?: unknown; h?: unknown };
    if (!d) return;
    if (d.pa === "turnstile" && typeof d.token === "string") {
      token = d.token;
      tokenUsed = false;
      setHelp(frameHelp, "", false);
    }
    if (d.pa === "turnstile-size") {
      const px = clampFrameHeight(d.h);
      if (px !== null) frame.style.height = px + "px";
    }
  };
  window.addEventListener("message", onFrameMessage);
  let draftTimer = 0;
  email.addEventListener("input", () => {
    emailField.classList.remove("bad");
    setHelp(emailHelp, "", false, email);
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => void rpc(env, "signinDraft", { email: email.value, purpose }).catch(() => undefined), 300) as unknown as number;
  });
  const sendBtn = h("button", { type: "submit", class: "primary big" }, "Email me a code") as HTMLButtonElement;
  describe(sendBtn, sendHelp, "send-help");
  const sendCode = async () => {
    setHelp(sendHelp, "", false);
    const v = email.value.trim();
    const bad = v === "" ? "Enter your email address." : /[^\x00-\x7f]/.test(v) ? T.badEmail : !/^[^@\s]+@[^@\s]+$/.test(v) ? "Check the email address." : "";
    if (bad) {
      emailField.classList.add("bad");
      setHelp(emailHelp, bad, true, email);
      email.focus();
      return;
    }
    if (!token || tokenUsed) {
      setHelp(frameHelp, "Finish the check above first.", true);
      return;
    }
    clearTimeout(draftTimer); // a late draft save must not overwrite the step 2 record
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
      sendBtn.disabled = false;
      sendBtn.textContent = "Email me a code";
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
      await done(await rpc<LoginResult>(env, "oauth", { provider, purpose }));
    } catch (e) {
      resetNotes(note("err", "error", (e as Error).message));
    }
  };
  const title = purpose === "delete-account" ? "Delete account" : purpose === "login" ? T.signedOut : "Sign in";
  const step1 = h(
    "div",
    { class: "step" },
    h("p", { class: "step-n" }, "Step 1 of 2"),
    h("h1", {}, title),
    h("p", { class: "sub" }, purpose === "delete-account" ? "Sign in to the account you want to delete." : "Use the same account on every device you want to pair."),
    resetNotes(),
    h(
      "div",
      { class: "oauth" },
      h("button", { type: "button", class: "big google", onclick: oauth("google") }, googleLogo(), "Sign in with Google"),
      h("button", { type: "button", class: "big apple", onclick: oauth("apple") }, appleLogo(), "Sign in with Apple"),
    ),
    h("div", { class: "or" }, "or sign in with email"),
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
  const signBtn = h("button", { type: "submit", class: "primary big" }, "Sign in") as HTMLButtonElement;
  const resend = h("button", { type: "button", class: "text" }, "Get a new code") as HTMLButtonElement;
  let sentAt = 0;
  let tick = 0;
  let busy = false;
  const countdown = () => {
    clearTimeout(tick);
    const left = resendLeftMs(sentAt, Date.now());
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? "Get a new code in " + clock(left) : "Get a new code";
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
        resetNotes(note("err", "error", msg));
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
    h("p", { class: "step-n" }, "Step 2 of 2"),
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
    frame.focus();
  });

  const card = h("div", { class: "l-card" }, back, h("div", { class: "l-brand" }, wordmark(env, 24)), step1, step2);
  const showEmail = (value: string) => {
    clearTimeout(tick);
    email.value = value;
    step1.hidden = false;
    step2.hidden = true;
    back.hidden = true;
    resetNotes();
    if (tokenUsed || !token) freshFrame(); // a used token, or a frame first loaded while hidden
    if (!value) email.focus();
  };
  const showCode = (addr: string, at: number, restored: boolean) => {
    email.value = addr;
    sentAt = at;
    clear(chip).append(h("span", { class: "ava" }, (addr.charAt(0) || "?").toUpperCase()), h("span", { class: "addr" }, addr));
    clear(s2notes);
    if (restored) {
      const t = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      s2notes.append(note("", "history", "Welcome back. You can pick up where you left off: the code we sent at " + t + " still works."));
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
      const deleted = purpose === "delete-account";
      const heading = h("h1", { tabindex: "-1" }, deleted ? "Account deleted" : "You are signed in");
      clear(card).append(
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
      heading.focus(); // the old controls are gone: read the result
    } else if (ff) {
      resetNotes(note("", "info", "Finish signing in in the new tab."));
    }
  };

  add(root, h("div", { class: "login" }, card, h("p", { class: "e2e" }, icon("lock", 20), h("span", {}, E2E))));
  if (saved && saved.step === "code") showCode(saved.email, saved.sentAt, true);
  else if (saved) {
    email.value = saved.email;
    if (saved.note === "expired") s1notes.prepend(note("", "history", "Your last code has expired. Get a new code to continue."));
  }
}

interface LimitPeer {
  id: string;
  platform: string;
  created: number;
  approves: number;
  approved_by: number;
  reachable: boolean;
  logged_out: boolean;
}

function limitView(env: UiEnv, root: HTMLElement, body: Record<string, unknown>, ticket: string): void {
  clear(root);
  document.body.classList.remove("signin-bg");
  const peers = (Array.isArray(body.peers) ? body.peers : []) as LimitPeer[];
  const boxes: { id: string; box: HTMLInputElement }[] = [];
  const status = h("div", { class: "status", role: "status" });
  const list = group();
  const heading = h("h1", { tabindex: "-1" }, "Device limit reached");
  root.append(heading, h("div", { class: "lead" }, "Pick devices to remove from this account, then continue."));
  for (const p of peers) {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement; // nothing pre-ticked
    boxes.push({ id: p.id, box });
    const flags = [p.reachable ? "" : "unreachable", p.logged_out ? "signed out" : ""].filter(Boolean).join(", ");
    list.append(
      h(
        "label",
        { class: "prow target" },
        h("div", { class: "av" }, platformIcon(p.platform)),
        h("div", { class: "txt t1" }, p.platform + ", added " + new Date(p.created * 1000).toISOString().slice(0, 10) + ", approves " + p.approves + ", approved by " + p.approved_by + (flags ? " (" + flags + ")" : "")),
        box,
      ),
    );
  }
  root.append(
    list,
    h(
      "div",
      { class: "btns" },
      h("button", {
        class: "primary",
        onclick: async () => {
          const evict = boxes.filter((b) => b.box.checked).map((b) => b.id);
          try {
            const r = await rpc<LoginResult>(env, "evict", { ticket, evict });
            if (r.done) clear(root).append(h("div", { class: "banner", role: "status", tabindex: "-1" }, "Signed in. You can close this tab."));
            if (r.done) root.querySelector<HTMLElement>(".banner")?.focus();
            else if (r.limit) limitView(env, root, r.limit, r.ticket ?? ticket);
          } catch (e) {
            status.textContent = (e as Error).message;
            if (status.textContent === "Sign-in expired, sign in again") env.openPage("#login");
          }
        },
      }, "Remove and continue"),
      h("button", { onclick: () => window.close() }, "Cancel"),
    ),
    status,
  );
  heading.focus();
}
