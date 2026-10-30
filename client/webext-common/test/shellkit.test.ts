import assert from "node:assert/strict";
import { test } from "node:test";
import { uiEnv } from "../src/shellkit.ts";

test("openPage: an open tab on the same page is focused and reloaded", async () => {
  const log: string[] = [];
  const url = "chrome-extension://x/page.html#signin";
  const b = {
    runtime: {
      getURL: (p: string) => "chrome-extension://x/" + p,
      getContexts: async () => [{ documentUrl: url, tabId: 7, windowId: 3 }],
      getManifest: () => ({ name: "PushArmor" }),
    },
    tabs: {
      update: async (id: number) => void log.push("update " + id),
      reload: async (id: number) => void log.push("reload " + id),
      create: async () => void log.push("create"),
    },
    windows: { update: async (id: number) => void log.push("window " + id) },
  };
  await uiEnv(b as never).openPage("#signin");
  assert.deepEqual(log, ["update 7", "window 3", "reload 7"]);
});
