import assert from "node:assert/strict";
import { test } from "node:test";
import { onMenuClick } from "../src/shellkit.ts";

test("a long selection cut inside an emoji still opens the send window", async () => {
  const urls: string[] = [];
  const b = {
    runtime: { getURL: (p: string) => "chrome-extension://x/" + p },
    tabs: { create: async (o: { url: string }) => void urls.push(o.url) },
  };
  const engine = { p: { notify: () => undefined, setBadge: () => undefined } };
  const text = "a".repeat(199999) + "\u{1F600}".repeat(1000);
  onMenuClick(b as never, async () => ({ engine }) as never, async () => text)({ menuItemId: "pa-sel|all", selectionText: "x" } as never);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(urls.length, 1);
  assert.ok(urls[0]!.startsWith("chrome-extension://x/page.html#send="));
});
