import assert from "node:assert/strict";
import { test } from "node:test";
import { N, body } from "./fakedom.ts";
import { mountPopup } from "../src/ui/popup.ts";
import type { UiEnv } from "../src/ui/dom.ts";

test("popup shown full screen (Firefox for Android) takes the screen width; a real popup keeps 400x560", async () => {
  const hang = { call: () => new Promise(() => undefined), theme: { get: () => new Promise(() => undefined), onChange() {} } };
  void mountPopup({ ...hang, inPopup: () => false } as unknown as UiEnv, new N("div") as unknown as HTMLElement);
  assert.ok(body.cls.has("full"));
  void mountPopup({ ...hang, inPopup: () => true } as unknown as UiEnv, new N("div") as unknown as HTMLElement);
  assert.ok(!body.cls.has("full"));
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/ui/style.css", import.meta.url), "utf8");
  assert.match(/\nbody\.full \{([^}]*)\}/.exec(css)![1]!, /width: auto;/);
  assert.match(css, /\.prow \{[^}]*grid-template-columns: 32px minmax\(0, 1fr\) auto;/);
  for (const f of ["popup.html", "page.html"]) {
    assert.match(readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8"), /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  }
});
