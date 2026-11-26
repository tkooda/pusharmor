import assert from "node:assert/strict";
import { test } from "node:test";
import { N } from "./fakedom.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];
const hasClass = (n: N, c: string) => n.cls.has(c) || (n.attrs.class ?? "").split(" ").includes(c);

test("Devices: a paired device's more menu has a separator directly above Remove device, apart from the checkbox items", async () => {
  const peer = { id: "p1", label: "Phone", platform: "android", lines: [], actions: ["remove"], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: true, approvesMe: true, paired: true, section: "paired" };
  const env = { call: async () => ({ ok: true, data: { self: { id: "me", name: "Me" }, peers: [peer], allowContent: true } }) } as unknown as UiEnv;
  const root = new N("div");
  await renderPeers(env, root as unknown as HTMLElement, false);
  const more = all(root).find((x) => hasClass(x, "more"))!;
  (more as unknown as { closest: () => null; getBoundingClientRect: () => object }).closest = () => null;
  (more as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ top: 0, bottom: 0 });
  (globalThis as unknown as { innerHeight: number }).innerHeight = 800;
  const btn = more.kids.find((x) => x.tag === "button")!;
  for (const f of btn.on.click!) f({});
  const menu = all(more).find((x) => hasClass(x, "menu"))!;
  const kids = menu.kids.map((k) => (k.attrs.role === "separator" ? "---" : k.attrs.role + ":" + k.kids.map((c) => c.textContent).join("").replace(/^\u2713/, "")));
  assert.deepEqual(kids, ["menuitemcheckbox:Show device on Send screen", "menuitemcheckbox:Show message content in notifications", "---", "menuitem:Remove device from account"]);
});
