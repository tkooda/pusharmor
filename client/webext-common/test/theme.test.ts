import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THEME_CHOICES, applyTheme, memoryThemeStore, parseTheme, setTheme } from "../src/ui/theme.ts";

test("theme: stored value parses to a choice, default Light (Q336)", () => {
  assert.equal(parseTheme("light"), "light");
  assert.equal(parseTheme("dark"), "dark");
  assert.equal(parseTheme("system"), "system");
  assert.equal(parseTheme(undefined), "light");
  assert.equal(parseTheme("DARK"), "light");
  assert.equal(parseTheme(1), "light");
  assert.deepEqual(THEME_CHOICES.map(([v]) => v), ["light", "dark", "system"]);
});

test("theme: theme.js sets Light before the stored value loads; only a saved System follows the system (Q336)", async () => {
  const g = globalThis as unknown as { document?: unknown; localStorage?: unknown };
  const had = { d: "document" in g, l: "localStorage" in g };
  const prevL = g.localStorage;
  try {
    for (const [saved, want] of [[null, "light"], ["dark", "dark"], ["light", "light"], ["bogus", "light"], ["system", undefined]] as const) {
      const root = { dataset: {} as DOMStringMap };
      g.document = { documentElement: root };
      g.localStorage = { getItem: () => saved };
      await import("../src/ui/themeboot.ts?" + String(saved));
      assert.equal(root.dataset.theme, want, String(saved));
    }
  } finally {
    if (!had.d) delete g.document;
    if (had.l) g.localStorage = prevL;
    else delete g.localStorage;
  }
});

test("theme: Light and Dark set data-theme, System removes it", () => {
  const root = { dataset: {} as DOMStringMap };
  applyTheme(root, "dark");
  assert.equal(root.dataset.theme, "dark");
  applyTheme(root, "light");
  assert.equal(root.dataset.theme, "light");
  applyTheme(root, "system");
  assert.equal("theme" in root.dataset, false);
});

test("theme: setTheme saves the choice", async () => {
  const g = globalThis as unknown as { document?: unknown };
  const had = "document" in g;
  g.document = { documentElement: { dataset: {} } };
  try {
    const store = memoryThemeStore(undefined);
    await setTheme(store, "dark");
    assert.equal(await store.get(), "dark");
    assert.equal((g.document as { documentElement: { dataset: DOMStringMap } }).documentElement.dataset.theme, "dark");
  } finally {
    if (!had) delete g.document;
  }
});

test("theme: tokens define dark twice (system and override) with a true black page; theme.js in the head", () => {
  for (const b of ["chrome", "firefox"]) {
    const css = readFileSync(new URL("../src/ui/tokens-" + b + ".css", import.meta.url), "utf8");
    assert.match(css, /:root:not\(\[data-theme="light"\]\) \{\s*--bg: #000000;/);
    assert.match(css, /:root\[data-theme="dark"\] \{\s*--bg: #000000;/);
  }
  for (const f of ["popup.html", "page.html"]) {
    const html = readFileSync(new URL("../src/ui/" + f, import.meta.url), "utf8");
    assert.ok(html.indexOf('<script src="theme.js">') < html.indexOf("</head>"), f + ": theme.js runs in the head");
  }
});
