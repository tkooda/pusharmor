// Full extension tab: login, Peers full view, limit picker, over-cap send
// (long flows run in a tab because a popup closes on blur, I029).
import type { LoginResult } from "../core/login.ts";
import type { StateView } from "../core/rpc.ts";
import { T } from "../core/texts.ts";
import { type UiEnv, add, clear, group, h, rpc } from "./dom.ts";
import { appleLogo, googleLogo, platformIcon } from "./icons.ts";
import { renderPeers } from "./peersview.ts";
import { historyView, sendView, wordmark } from "./popup.ts";

export const SITE = "https://pusharmor.com";

export async function mountPage(env: UiEnv, root: HTMLElement, hash: string, selfOrigin: string): Promise<void> {
  clear(root);
  const [route, arg] = hash.replace(/^#/, "").split("=");
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

async function loginView(env: UiEnv, root: HTMLElement, forced: string | null, selfOrigin: string): Promise<void> {
  const purpose = forced === "delete-account" ? "delete-account" : await rpc<string>(env, "loginPurpose");
  const st = await rpc<StateView>(env, "state");
  const status = h("div", { class: "status" });
  const email = h("input", { type: "email", placeholder: "Email address", autocomplete: "email" }) as HTMLInputElement;
  const code = h("input", { class: "code", placeholder: "Code", maxlength: "20", autocomplete: "one-time-code" }) as HTMLInputElement;
  const codeRow = h("div", { class: "row", hidden: true }, code);
  let token = "";
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.origin !== SITE) return;
    const d = ev.data as { pa?: string; token?: string };
    if (d && d.pa === "turnstile" && typeof d.token === "string") token = d.token;
  });
  const frame = h("iframe", { src: SITE + "/turnstile#o=" + encodeURIComponent(selfOrigin), class: "turnstile", title: "Turnstile" });
  const done = async (r: LoginResult) => {
    if (r.limit) return limitView(env, root, r.limit, r.ticket ?? "");
    if (r.done) {
      clear(root).append(h("div", { class: "banner" }, purpose === "delete-account" ? "Account deleted" : "Signed in. You can close this tab."));
    } else status.textContent = st.platform === "firefox" ? "Finish the sign-in in the new tab." : "";
  };
  const verify = async () => {
    try {
      await done(await rpc<LoginResult>(env, "emailVerify", { code: code.value }));
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  code.addEventListener("input", () => {
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
  const sendCode = h("button", {
    class: "primary big",
    onclick: async () => {
      if (/[^\x00-\x7f]/.test(email.value)) {
        status.textContent = T.badEmail;
        return;
      }
      if (!token) {
        status.textContent = "Complete the check above first.";
        return;
      }
      try {
        await rpc(env, "emailStart", { email: email.value, turnstile: token, purpose });
        codeRow.hidden = false;
        status.textContent = "Code sent. Check your email.";
      } catch (e) {
        status.textContent = (e as Error).message;
      }
    },
  }, "Email me a code");
  const oauth = (provider: string) => async () => {
    try {
      await done(await rpc<LoginResult>(env, "oauth", { provider, purpose }));
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  add(
    root,
    h(
      "div",
      { class: "login" },
      h("div", { class: "login-head" }, h("img", { src: "icons/icon-48.png", width: "28", height: "28", alt: "" }), wordmark(env, 18)),
      add(
        h("div", { class: "p-card" }),
        h("h1", {}, purpose === "delete-account" ? "Delete account" : purpose === "unpause" ? T.signedOut : "Sign in to PushArmor"),
        st.banner ? h("div", { class: "banner" }, st.banner) : null,
        st.platform === "firefox" && !st.reg ? h("div", { class: "dim" }, T.ffFinishSetup) : null,
        st.receiveNote ? h("div", { class: "dim" }, st.receiveNote) : null,
        h("div", { class: "row" }, email),
        frame,
        sendCode,
        codeRow,
        h("div", { class: "or" }, "or"),
        h(
          "div",
          { class: "oauth" },
          h("button", { class: "big google", onclick: oauth("google") }, googleLogo(), "Sign in with Google"),
          h("button", { class: "big apple", onclick: oauth("apple") }, appleLogo(), "Sign in with Apple"),
        ),
      ),
      status,
      h("p", { class: "dim same" }, "Use the same account on every device you want to pair."),
    ),
  );
}

interface LimitPeer {
  id: string;
  platform: string;
  created: number;
  approves: number;
  approved_by: number;
  reachable: boolean;
  paused: boolean;
}

function limitView(env: UiEnv, root: HTMLElement, body: Record<string, unknown>, ticket: string): void {
  clear(root);
  const peers = (Array.isArray(body.peers) ? body.peers : []) as LimitPeer[];
  const boxes: { id: string; box: HTMLInputElement }[] = [];
  const status = h("div", { class: "status" });
  const list = group();
  root.append(h("h1", {}, "Peer limit reached"), h("div", { class: "lead" }, "Pick peers to remove from this account, then continue."));
  for (const p of peers) {
    const box = h("input", { type: "checkbox" }) as HTMLInputElement; // nothing pre-ticked
    boxes.push({ id: p.id, box });
    const flags = [p.reachable ? "" : "unreachable", p.paused ? "signed out" : ""].filter(Boolean).join(", ");
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
            if (r.done) clear(root).append(h("div", { class: "banner" }, "Signed in. You can close this tab."));
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
}
