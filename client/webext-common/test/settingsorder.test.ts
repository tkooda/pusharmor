import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Settings: the Files section sits directly above History; the other sections keep their order", () => {
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  const view = pop.slice(pop.indexOf("async function settingsView("));
  const order = [...view.matchAll(/sh\("([A-Za-z ]+)"\)/g)].map((m) => m[1]);
  const at = (s: string) => order.indexOf(s);
  assert.ok(at("Files") >= 0 && at("History") === at("Files") + 1, order.join(", "));
  assert.ok(at("Receiving") === at("Files") - 1, order.join(", "));
  assert.ok(at("Account") === at("History") + 1, order.join(", "));
});
