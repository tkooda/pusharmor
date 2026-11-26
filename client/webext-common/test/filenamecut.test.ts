import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NAME_CUT, cutFileName } from "../src/model/filename.ts";
import * as F from "../src/model/filerow.ts";
import { storageFullText } from "../src/model/filerules.ts";
import { fileOpenFailed } from "../src/core/files.ts";
import { saveFailText } from "../src/core/texts.ts";

const LONG = "Quarterly budget review final version 3.pdf";

test("a file name in a toast or error is cut in the middle to 24 characters; a short name stays whole", () => {
  assert.equal(NAME_CUT, 24);
  assert.equal(cutFileName("report.pdf"), "report.pdf");
  assert.equal(cutFileName("x".repeat(24)), "x".repeat(24));
  const cut = cutFileName(LONG);
  assert.equal(cut, "Quarterly budg...n 3.pdf");
  assert.equal([...cut].length, 24);
  const short = "Quarterly budg...n 3.pdf";
  assert.equal(F.tooLarge(LONG), '"' + short + '" is too large to send');
  assert.equal(F.unreadable(LONG), 'Unable to read "' + short + '"');
  assert.equal(F.noMemoryToast(LONG), 'Not enough memory to decrypt "' + short + '"');
  assert.equal(F.saved(LONG), 'Saved "' + short + '"');
  assert.equal(storageFullText("upload", LONG), 'Not enough storage to send "' + short + '"');
  assert.equal(fileOpenFailed(LONG), 'Unable to decrypt "' + short + '"\nTry again');
  assert.equal(saveFailText(new Error("x"), LONG).split("\n")[0], 'Unable to save "' + short + '"');
  assert.equal(F.tooLarge("cat.png"), '"cat.png" is too large to send');
});

test("the Copy image error cuts the file name in the middle; no toast in the popup quotes an uncut file name", () => {
  const pop = readFileSync(new URL("../src/ui/popup.ts", import.meta.url), "utf8");
  assert.match(pop, /toast\('Unable to copy "' \+ cutFileName\(name\) \+ '"', "err"\)/);
  assert.doesNotMatch(pop, /'"' \+ (name|f\.name|r\.content|chosen\.name) \+ '"'/);
});
