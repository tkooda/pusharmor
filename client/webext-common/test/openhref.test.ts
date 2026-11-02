import assert from "node:assert/strict";
import { test } from "node:test";
import { openHref } from "../src/ui/dom.ts";

test("a phone number with leading spaces does not get a second tel: prefix", () => {
  assert.equal(openHref("tel", " tel:+15551234567"), "tel:+15551234567");
  assert.equal(openHref("tel", "  +15551234567 "), "tel:+15551234567");
  assert.equal(openHref("url", " https://a.example/"), " https://a.example/");
});
