// Pure helpers for the operator ban script.

const enc = new TextEncoder();

export function normalizeEmail(s) {
  const t = String(s).replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) > 127) throw new Error("bad email");
  }
  return t.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function b64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function emailHash(normalized) {
  const d = await globalThis.crypto.subtle.digest(
    "SHA-256",
    enc.encode("PA-ACCT1\n" + normalized),
  );
  return new Uint8Array(d);
}

// Strict canonical b64url decode (same rules as the Worker); throws on bad input.
export function b64urlDecode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new Error("bad b64url");
  }
  const out = Buffer.from(s, "base64url");
  if (b64url(out) !== s) throw new Error("bad b64url");
  return new Uint8Array(out);
}

// ID_SECRET is the b64url form of at least 32 random bytes; the HMAC key is the decoded bytes.
export async function accountId(idSecret, emailHashBytes) {
  const raw = b64urlDecode(idSecret);
  if (raw.length < 32) throw new Error("bad ID_SECRET");
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", key, emailHashBytes),
  );
  return b64url(mac.slice(0, 9));
}

export function assertAccountId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(id)) {
    throw new Error("bad account id");
  }
}

export function banSql(id, nowSeconds) {
  assertAccountId(id);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) {
    throw new Error("bad time");
  }
  return (
    `INSERT INTO accounts (id, created, status, last_seen_month) VALUES ('${id}', ${nowSeconds}, 'banned', ${nowSeconds}) ON CONFLICT (id) DO UPDATE SET status = 'banned'; ` +
    `DELETE FROM peers WHERE account = '${id}';`
  );
}
