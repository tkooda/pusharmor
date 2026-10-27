// Firefox bindings (sections 5.2, 5.3): own autopush client on desktop, the
// pusharmor.com site SW forward on Android and in fallback mode.
import type { PushFields } from "../../webext-common/src/crypto/labels.ts";
import type { Platform } from "../../webext-common/src/platform.ts";
import { basePlatform } from "../../webext-common/src/shellkit.ts";
import type { Db } from "../../webext-common/src/store/db.ts";
import type { Autopush } from "./autopush/client.ts";
import { browser } from "./shim.ts";

export const SETUP_URL = "https://pusharmor.com/fx/setup";
export const FWD_URL = "https://pusharmor.com/fx/fwd";

/** Same prefix list the Worker uses (catalog Web push endpoint allow-list). */
export const ALLOWED_PUSH_ENDPOINT_PREFIXES = [
  "https://fcm.googleapis.com/fcm/send/",
  "https://fcm.googleapis.com/wp/",
  "https://updates.push.services.mozilla.com/wpush/v1/",
  "https://updates.push.services.mozilla.com/wpush/v2/",
];

export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return ALLOWED_PUSH_ENDPOINT_PREFIXES.some((p) => {
    const pu = new URL(p);
    return u.host === pu.host && u.pathname.startsWith(pu.pathname);
  });
}

export interface FxCtx {
  isAndroid: boolean;
  autopush: () => Autopush | null;
  db: () => Promise<Db>;
}

export function firefoxPlatform(ctx: FxCtx): Platform {
  const fallback = async (): Promise<PushFields | null> => {
    const db = await ctx.db();
    return (await db.meta<PushFields>("fallback_push")) ?? null;
  };
  const direct = async (): Promise<boolean> => {
    if (ctx.isAndroid) return false;
    const db = await ctx.db();
    return ((await db.meta<string>("receive_mode")) ?? "direct") === "direct";
  };
  return basePlatform(browser, "firefox", ctx.isAndroid, {
    async pushSubscribe() {
      if (!(await direct())) {
        const f = await fallback();
        if (!f) {
          await browser.tabs.create({ url: SETUP_URL, active: true }); // loss state: reopen /fx/setup
          throw new Error("no fallback subscription");
        }
        return f;
      }
      const ap = ctx.autopush();
      if (!ap) throw new Error("autopush not running");
      for (let i = 0; i < 30; i++) {
        const f = await ap.fields();
        if (f) return f;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error("autopush registration pending");
    },
    async pushCurrent() {
      if (!(await direct())) return fallback();
      return (await ctx.autopush()?.fields()) ?? null;
    },
    async pushUnsubscribe() {
      await ctx.autopush()?.unregister();
      const db = await ctx.db();
      await db.del("meta", "fallback_push");
    },
  });
}
