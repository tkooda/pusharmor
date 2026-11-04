// Chrome bindings: Push API in the extension service worker (section 5.1).
import { b64urlEncode } from "../../webext-common/src/crypto/b64url.ts";
import { buf } from "../../webext-common/src/crypto/bytes.ts";
import type { PushFields } from "../../webext-common/src/crypto/labels.ts";
import { type Platform, PushRefused } from "../../webext-common/src/platform.ts";
import { knownChromeId } from "../../webext-common/src/model/signin.ts";
import { basePlatform } from "../../webext-common/src/shellkit.ts";
import { browser } from "./shim.ts";

declare const CHROME_EXTENSION_IDS: string[];

interface PushSub {
  endpoint: string;
  getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
  unsubscribe(): Promise<boolean>;
}
interface PushManagerLike {
  subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSub>;
  getSubscription(): Promise<PushSub | null>;
}

function pm(): PushManagerLike {
  return (globalThis as unknown as { registration: { pushManager: PushManagerLike } }).registration.pushManager;
}

function fields(s: PushSub): PushFields {
  const k = s.getKey("p256dh");
  const a = s.getKey("auth");
  if (!k || !a) throw new Error("subscription without keys");
  return { type: "webpush", endpoint: s.endpoint, p256dh: b64urlEncode(new Uint8Array(k)), auth: b64urlEncode(new Uint8Array(a)) };
}

/**
 * Subscribe; fresh drops the current subscription first (new endpoint). A subscription made with
 * another key makes subscribe throw InvalidStateError: it is dropped and subscribe runs once more.
 * A subscribe that still fails while online is a PushRefused: a refused permission, or no
 * working push service (it fails, or never answers within waitMs, as where a build removed it).
 */
export async function subscribeRecovering(m: PushManagerLike, vapid: Uint8Array, fresh: boolean, waitMs = SUBSCRIBE_WAIT_MS): Promise<PushSub> {
  const o = { userVisibleOnly: false, applicationServerKey: buf(vapid) };
  if (fresh) await (await m.getSubscription())?.unsubscribe();
  const bounded = (p: Promise<PushSub>): Promise<PushSub> => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => (t = setTimeout(() => no(new DOMException("no answer from the push service", "AbortError")), waitMs)));
    return Promise.race([p, late]).finally(() => clearTimeout(t));
  };
  try {
    try {
      return await bounded(m.subscribe(o));
    } catch (e) {
      if (!(e instanceof Error && e.name === "InvalidStateError")) throw e;
      await (await m.getSubscription())?.unsubscribe();
      return await bounded(m.subscribe(o));
    }
  } catch (e) {
    if (globalThis.navigator?.onLine === false) throw e;
    throw new PushRefused(e instanceof Error ? e.message : String(e), !(e instanceof Error && e.name === "NotAllowedError"));
  }
}

/** How long a subscribe may take before the browser counts as having no push service. */
export const SUBSCRIBE_WAIT_MS = 20_000;

export function chromePlatform(): Platform {
  const p = basePlatform(browser, "chrome", false, {
    async pushSubscribe(vapid, _quiet, fresh) {
      return fields(await subscribeRecovering(pm(), vapid, fresh === true));
    },
    async pushCurrent() {
      const s = await pm().getSubscription();
      return s ? fields(s) : null;
    },
    async pushUnsubscribe() {
      const s = await pm().getSubscription();
      if (s) await s.unsubscribe();
    },
  });
  p.chromeIdKnown = knownChromeId(browser.runtime.id, CHROME_EXTENSION_IDS);
  return p;
}
