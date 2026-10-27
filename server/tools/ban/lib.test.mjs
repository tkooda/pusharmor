import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  normalizeEmail,
  b64url,
  emailHash,
  accountId,
  assertAccountId,
  banSql,
} from "./lib.mjs";

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail(" A@B.Com "), "a@b.com");
});

test("normalizeEmail rejects non-ASCII", () => {
  assert.throws(() => normalizeEmail("\u00c9@b.com"), /bad email/);
});

test("b64url known answers", () => {
  assert.equal(b64url(new Uint8Array([0xfb, 0xff, 0xfe])), "-__-");
  assert.equal(b64url(new Uint8Array([1])), "AQ");
  assert.equal(b64url(new Uint8Array([])), "");
});

test("assertAccountId", () => {
  assertAccountId("AAAAAAAAAAAA");
  assertAccountId("a-_Z09abcdef");
  for (const bad of ["abc", "abcdefghijk!", "abcdefghijklm", "'; DROP"]) {
    assert.throws(() => assertAccountId(bad), /bad account id/);
  }
});

test("banSql refuses bad id and bad time", () => {
  assert.throws(() => banSql("'; DROP", 1761300000));
  assert.throws(() => banSql("AAAAAAAAAAAA", 0));
  assert.throws(() => banSql("AAAAAAAAAAAA", 1.5));
});

test("banSql exact output", () => {
  assert.equal(
    banSql("AAAAAAAAAAAA", 1761300000),
    "INSERT INTO accounts (id, created, status, last_seen_month) VALUES ('AAAAAAAAAAAA', 1761300000, 'banned', 1761300000) ON CONFLICT (id) DO UPDATE SET status = 'banned'; " +
      "DELETE FROM peers WHERE account = 'AAAAAAAAAAAA';",
  );
});

// Golden vectors (tests/vectors/golden-v1.json, keys.id_secret and email_hash cases).
test("accountId matches the golden vectors", async () => {
  const secret = "osEEqky1lYCunccbAIKM8-8MjkclYI6MwNlG8WtzstM";
  assert.equal(await accountId(secret, await emailHash(normalizeEmail("alice@example.com"))), "CuVpna7--Emb");
  assert.equal(await accountId(secret, await emailHash(normalizeEmail(" A@B.Com "))), "QSXIfRk3ghIJ");
  await assert.rejects(accountId("not b64url!", new Uint8Array(32)));
  await assert.rejects(accountId("AAAA", new Uint8Array(32)));
});

test("emailHash and accountId cross-check with node:crypto", async () => {
  const secret = "dGVzdC1pZC1zZWNyZXQtZm9yLXRoZS1iYW4tdG9vbC0w";
  const h = await emailHash(normalizeEmail("a@b.com"));
  const refHash = createHash("sha256").update("PA-ACCT1\na@b.com", "utf8").digest();
  assert.deepEqual(Buffer.from(h), refHash);
  const id = await accountId(secret, h);
  const refMac = createHmac("sha256", Buffer.from(secret, "base64url")).update(refHash).digest();
  const refId = refMac.subarray(0, 9).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  assert.equal(id.length, 12);
  assert.equal(id, refId);
});
