import { test } from "node:test";
import assert from "node:assert/strict";
import { offscreenHost } from "../../chrome/src/offhost.ts";
import { HostGone } from "../src/core/files.ts";
import type { Browser } from "../src/shim-types.ts";

// a document that closes under every job (its sendMessage rejects); counts the job messages
function closingBrowser(): { b: Browser; jobs: () => number } {
  let jobs = 0;
  const b = {
    runtime: {
      getContexts: async () => [{}],
      getManifest: () => ({ name: "PushArmor", version: "1.2.3" }),
      sendMessage: async (m: { req: { op: string } }) => {
        if (m.req.op === "idle") return { idle: false };
        jobs++;
        throw new Error("message port closed");
      },
    },
    offscreen: { createDocument: async () => undefined, closeDocument: async () => undefined },
  } as unknown as Browser;
  return { b, jobs: () => jobs };
}

test("offscreen host: a decrypt whose document closed is never run again; other jobs run once more", async () => {
  const d = closingBrowser();
  const host = offscreenHost(d.b);
  await assert.rejects(host.run({ op: "decrypt", key: "k", fileKey: "f" }), HostGone);
  assert.equal(d.jobs(), 1, "the decrypt ran once");
  await assert.rejects(host.run({ op: "upload", picked: "p" }), HostGone);
  assert.equal(d.jobs(), 3, "the upload ran twice");
});
