// Chrome bindings: Push API in the extension service worker (section 5.1).
import { b64urlEncode } from "../../webext-common/src/crypto/b64url.ts";
import { buf } from "../../webext-common/src/crypto/bytes.ts";
import type { PushFields } from "../../webext-common/src/crypto/labels.ts";
import type { Platform } from "../../webext-common/src/platform.ts";
import { basePlatform } from "../../webext-common/src/shellkit.ts";
import { browser } from "./shim.ts";

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

export function chromePlatform(): Platform {
  return basePlatform(browser, "chrome", false, {
    async pushSubscribe(vapid) {
      return fields(await pm().subscribe({ userVisibleOnly: false, applicationServerKey: buf(vapid) }));
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
}
