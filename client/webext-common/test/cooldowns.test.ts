// Cooldown presence per control: Check again 10 s; rename Save has an in-flight guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const popup = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
const peers = readFileSync(new URL("../src/ui/peersview.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/ui/page.ts", import.meta.url), "utf8");

test("Check again is greyed 10 s after a tap and again in the redrawn toast", () => {
  assert.match(popup, /checkAgainUntil = Date\.now\(\) \+ 10_000;\s+disableFor\(b, 10_000\)/);
  assert.match(popup, /disableFor\(again, left\)/);
});

test("Send, Remove, Log in have no cooldown", () => {
  const send = popup.slice(popup.indexOf("sendBtn.addEventListener"));
  assert.doesNotMatch(send.slice(0, 1800), /disableFor|greyFor/);
  assert.doesNotMatch(page.slice(page.indexOf("const verify")), /disableFor\(signBtn|greyFor\(signBtn/);
  const rm = peers.slice(peers.indexOf('if (a === "remove")'), peers.indexOf("const op ="));
  assert.doesNotMatch(rm, /disableFor|greyFor/);
});

test("rename Save ignores a second submit while one runs", () => {
  assert.match(peers, /let saving = false;[\s\S]*if \(saving\) return;\s+saving = true;[\s\S]*finally \{\s+saving = false;/);
});

test("settings save() shows an error toast when the call fails", () => {
  assert.match(popup, /"settings", \{[^\n]*\}\)\.catch\(\(\) =>\s+toast\("Could not save the settings/);
});

test("no periodic relay-server call: the only timers in the background scripts are local", () => {
  const fx = readFileSync(new URL("../../firefox/src/background.ts", import.meta.url), "utf8");
  assert.doesNotMatch(fx, /setInterval\([^)]*(api|fetchPeers|onFetchAlarm)/);
  assert.doesNotMatch(readFileSync(new URL("../src/core/engine.ts", import.meta.url), "utf8"), /periodInMinutes|setInterval/);
});
