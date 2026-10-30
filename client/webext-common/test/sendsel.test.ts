import assert from "node:assert/strict";
import { test } from "node:test";
import { canReceiveNow, rememberedSelection, sendDisabled, sendToHeader, showAllChip, showCounter } from "../src/model/sendsel.ts";

test("Send view: remembered selection keeps only ids that can still receive", () => {
  assert.deepEqual(rememberedSelection(["a", "gone", "c"], ["a", "b", "c"]), ["a", "c"]);
});

test("Send view: no usable memory gives null (default selection)", () => {
  assert.equal(rememberedSelection(undefined, ["a"]), null);
  assert.equal(rememberedSelection([], ["a"]), null);
  assert.equal(rememberedSelection(["x"], ["a"]), null);
});

test("Send view: header counts selected of sendable devices", () => {
  assert.equal(sendToHeader(6, 9), "Send to (6 of 9)");
  assert.equal(sendToHeader(0, 1), "Send to (0 of 1)");
});

test("Send view: All chip only with 2 or more devices and the setting on", () => {
  assert.equal(showAllChip(true, 1), false);
  assert.equal(showAllChip(true, 2), true);
  assert.equal(showAllChip(false, 9), false);
  assert.equal(showAllChip(true, 0), false);
});

test("Send view: byte counter shows from 90 percent of the cap", () => {
  assert.equal(showCounter(0, 2048), false);
  assert.equal(showCounter(1843, 2048), false);
  assert.equal(showCounter(1844, 2048), true);
  assert.equal(showCounter(3000, 2048), true);
});

test("Send view: greyed devices cannot receive now", () => {
  assert.equal(canReceiveNow({ sendable: true, greyed: null }), true);
  assert.equal(canReceiveNow({ sendable: true, greyed: "unreachable" }), false);
  assert.equal(canReceiveNow({ sendable: true, greyed: "logged out" }), false);
  assert.equal(canReceiveNow({ sendable: false, greyed: null }), false);
});

test("Send view: Send is disabled with no device selected", () => {
  assert.equal(sendDisabled(10, 2048, 0), true);
  assert.equal(sendDisabled(10, 2048, 1), false);
  assert.equal(sendDisabled(0, 2048, 1), true);
  assert.equal(sendDisabled(3000, 2048, 1), true);
});
