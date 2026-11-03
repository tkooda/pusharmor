// A device name in a text is always in straight double quotes. A device with no name yet
// reads "A device", without quotes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { T } from "../src/core/texts.ts";

const fns = Object.entries(T).filter(([, v]) => typeof v === "function" && v.length === 1) as [string, (x: string) => string][];
const named = ["pairHalf", "pairCrossing", "approved", "denied", "loggedOutRecv", "loggedInRecv", "newMessageFrom", "pairingWith", "wantsToPair", "waiting", "noReplyYet", "stillHolds", "notPairedOn", "declinedBy", "removeConfirm", "removedDevice"];

test("every text with a device name quotes it", () => {
  for (const k of named) assert.ok(fns.some(([n]) => n === k), k);
  for (const [k, f] of fns) {
    if (!named.includes(k)) continue;
    const s = f("Zed");
    assert.ok(s.includes('"Zed"'), k + ": " + s);
    assert.equal(s.split("Zed").length - 1, s.split('"Zed"').length - 1, k + ": " + s);
  }
});

test("device name texts keep their words, with the name quoted", () => {
  assert.equal(T.loggedOutRecv("X"), '"X" logged out.');
  assert.equal(T.loggedInRecv("X"), '"X" logged in.');
  assert.equal(T.denied("X"), '"X" rejected this device.');
  assert.equal(T.approved("X"), '"X" confirmed this device.');
  assert.equal(T.stillHolds("X"), '"X" still holds an earlier pairing. On "X", click Cancel pairing request, then click Send again.');
  assert.equal(T.declinedBy("X"), 'Rejected by "X".');
  assert.equal(T.notPairedOn("X"), 'Not paired on "X".');
  assert.equal(T.wantsToPair("X"), '"X" wants to pair.');
  assert.equal(T.pairCrossing("X"), 'Pairing with "X" is in progress. Open PushArmor.');
  assert.equal(T.pairingWith("X"), 'Pairing with "X". Waiting for its reply.');
  assert.equal(T.waiting("X"), 'Waiting for "X": open PushArmor there, compare the codes on both devices, and click Codes match only if they are the same.');
  assert.equal(T.noReplyYet("X"), 'No reply yet. Open PushArmor on "X", or click Send again.');;
  assert.equal(T.removeConfirm("X"), 'Remove "X" from this account? It must log in again and pair with every device again.');
  assert.equal(T.removedDevice("X"), 'Removed "X".');
  assert.equal(T.loggedOutRecv(T.aPeer), "A device logged out.");
  assert.equal(T.declinedBy(T.aPeer), "Rejected by A device.");
});

test("the popup and the device list quote device names in toasts and the filter", () => {
  const pv = readFileSync(new URL("../src/ui/peersview.ts", import.meta.url), "utf8");
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pv, /msg = T\.removedDevice\(p\.label\);/);
  assert.match(pop, /c\.title = greyedText\(p\.label, p\.greyed \?\? ""\);/);
  assert.match(pop, /toast\(c\.title, "info"\);/);
  assert.match(pop, /"From " \+ quoted\(label\)/);
});
