import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
const rule = (sel: string) => css.split("\n").find((l) => l.startsWith(sel + " {")) ?? "";

test("button labels never wrap mid-label; button rows wrap as a whole with the action on top", () => {
  assert.match(rule("button"), /white-space: nowrap/);
  assert.match(rule(".dlg-acts button"), /white-space: nowrap/);
  for (const r of [".dlg-acts", ".hselbar"]) assert.match(rule(r), /flex-wrap: wrap-reverse/, r);
});
