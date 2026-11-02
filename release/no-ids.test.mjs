// release/no-ids.mjs: internal tracking ids are kept out of tracked files and
// commit messages. Run: node --test release/no-ids.test.mjs
// Every id below is built by concatenation so this file does not match itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { idHits } from "./no-ids.mjs";

const Q = "Q";
const I = "I";

test("question, ruling, issue, review and session ids are found", () => {
  for (const s of [
    "fix the send button (" + Q + "123)",
    "owner ruled " + Q + "93 A on this",
    "done per " + Q + "93",
    "closes " + I + "456",
    "see " + I + "639.",
    "(" + I + "12) fixed",
    "review WRK" + "-01 says",
    "COST" + "-01, PROTO" + "-01",
    "Claude" + "-Session: https://example.invalid/x"
  ]) assert.notDeepEqual(idHits(s), [], s);
});

test("hex, base64, CSS, platform ids, IPv6 and versions are not ids", () => {
  for (const s of [
    '"integrity": "sha512-NBdY' + I + "b90J7LfO" + I + "32dOewK/" + I + '2/r7w=="',
    "let x = i64(n); i32(m)",
    "SHA-256, SHA-1, UTF-8, UTF-16, ISO-8859-1, RFC-8291",
    "color: #" + I + "1A2B3; margin: 0 auto",
    "R.id.Q1; android:id=@+id/" + I + "12; CFBundle" + I + "D",
    "2001:db8::" + I + "1",
    "version 0.0.21, v1.2.3-rc.1, " + Q + "1 of 2024",
    "BCxadZ_SCcdg9fAFF" + I + "77KQBYA",
    "Quarter " + Q + "1 B-side"
  ]) assert.deepEqual(idHits(s), [], s);
});

test("the tracked tree and the full history of HEAD pass", () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "no-ids.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
