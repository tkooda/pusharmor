import assert from "node:assert/strict";
import { test } from "node:test";
import { updateUrl } from "../src/ui/popup.ts";

const DL = "https://pusharmor.com/download";

test("Update opens the store listing for a store install, else the download page", () => {
  assert.equal(updateUrl("normal", "chrome"), "https://chromewebstore.google.com/detail/pusharmor/eglfppbcdpmgpnckkgcjcmmbknjgeihd");
  assert.equal(updateUrl("normal", "firefox"), "https://addons.mozilla.org/firefox/addon/pusharmor/");
  for (const t of ["development", "sideload", "admin", "other", "", undefined]) {
    assert.equal(updateUrl(t, "chrome"), DL, String(t));
    assert.equal(updateUrl(t, "firefox"), DL, String(t));
  }
  assert.equal(updateUrl("normal", "other"), DL);
});
