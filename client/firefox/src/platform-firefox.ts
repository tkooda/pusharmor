// Firefox bindings (sections 5.2, 5.3): own autopush client on desktop, the
// pusharmor.com site SW forward on Android and in fallback mode.
import type { PushFields } from "../../webext-common/src/crypto/labels.ts";
import type { Platform } from "../../webext-common/src/platform.ts";
import { basePlatform } from "../../webext-common/src/shellkit.ts";
import type { Db } from "../../webext-common/src/store/db.ts";
import type { Autopush } from "./autopush/client.ts";
import { ALLOWED_PUSH_ENDPOINT_PREFIXES, endpointAllowed } from "./endpoint.ts";
import { browser } from "./shim.ts";

export const SETUP_URL = "https://pusharmor.com/fx/setup";
export const FWD_URL = "https://pusharmor.com/fx/fwd";

export { ALLOWED_PUSH_ENDPOINT_PREFIXES, endpointAllowed };

/** Opens /fx/setup in a normal (not private) window: push and the add-on do not work in a private tab. */
export async function openSetup(): Promise<void> {
  const w = browser.windows;
  if (w?.getAll) {
    const normal = (await w.getAll({ windowTypes: ["normal"] })).filter((x) => !x.incognito && x.id !== undefined);
    const win = normal.find((x) => x.focused) ?? normal[normal.length - 1];
    if (win) {
      await browser.tabs.create({ url: SETUP_URL, active: true, windowId: win.id });
      await w.update(win.id!, { focused: true });
      return;
    }
    if (w.create) {
      await w.create({ url: SETUP_URL, incognito: false, focused: true });
      return;
    }
  }
  await browser.tabs.create({ url: SETUP_URL, active: true });
}

interface FxCtx {
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
    async pushSubscribe(_vapid, quiet) {
      if (!(await direct())) {
        const f = await fallback();
        if (!f) {
          // loss state: reopen /fx/setup once per state change; the popup shows a button instead
          const db = await ctx.db();
          if (!quiet && !(await db.meta("setup_opened"))) {
            await db.setMeta("setup_opened", true);
            await openSetup();
          }
          throw new Error("no fallback subscription");
        }
        return f;
      }
      const ap = ctx.autopush();
      if (!ap) throw new Error("autopush not running");
      await ap.ensureRunning();
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
      await db.del("meta", "receive_mode");
      await db.del("meta", "setup_opened");
    },
  });
}
