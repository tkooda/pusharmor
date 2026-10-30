import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberedSelection } from "../src/model/sendsel.ts";

test("Send view: remembered selection keeps only ids that can still receive", () => {
  assert.deepEqual(rememberedSelection(["a", "gone", "c"], ["a", "b", "c"]), ["a", "c"]);
});

test("Send view: no usable memory gives null (default selection)", () => {
  assert.equal(rememberedSelection(undefined, ["a"]), null);
  assert.equal(rememberedSelection([], ["a"]), null);
  assert.equal(rememberedSelection(["x"], ["a"]), null);
});
