// B2 S3 store with fetch mocked: signing, streamed put with the SHA-256 checksum, error
// mapping (hash mismatch, cap, other), ranges, paged lists, and deletes of every version.
import { describe, expect, it } from "vitest";
import { B2Error, B2Store } from "../src/file/b2";
import { canonicalRequest, deriveSigningKey } from "../src/auth/sigv4";
import { sha256 } from "../src/crypto/hash";
import { randBytes } from "./helpers";

const CFG = { keyId: "KEYID0001", appKey: "app-key-secret-0001", bucket: "bkt", endpoint: "https://s3.us-east-005.backblazeb2.com", region: "us-east-005" };
const KEY = "v1/202612312359/0123456789abcdef/202612312359-0123456789abcdef0123456789abcdef";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function mock(replies: (Response | ((s: Seen) => Response))[]): { store: B2Store; seen: Seen[] } {
  const seen: Seen[] = [];
  const store = new B2Store(CFG, async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers as HeadersInit));
    const body = init.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : null;
    const s = { url, method: init.method ?? "GET", headers, body };
    seen.push(s);
    const r = replies.shift();
    if (!r) throw new Error("no reply");
    return typeof r === "function" ? r(s) : r;
  });
  return { store, seen };
}

const xmlErr = (status: number, code: string, msg = "x") =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${msg}</Message></Error>`, { status });

const hexOf = (b: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

// Recomputes the SigV4 signature from the request as sent.
async function checkSigned(s: Seen): Promise<void> {
  const m = /^AWS4-HMAC-SHA256 Credential=KEYID0001\/(\d{8})\/us-east-005\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(s.headers.authorization);
  expect(m).not.toBeNull();
  const signed: Record<string, string> = {};
  for (const n of m![2].split(";")) signed[n] = s.headers[n];
  expect(s.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  const { canonical } = canonicalRequest(s.method, new URL(s.url), signed, "UNSIGNED-PAYLOAD");
  const date = s.headers["x-amz-date"];
  const sts = ["AWS4-HMAC-SHA256", date, `${m![1]}/us-east-005/s3/aws4_request`, hexOf(await sha256(new TextEncoder().encode(canonical)))].join("\n");
  const k = await crypto.subtle.importKey("raw", await deriveSigningKey(CFG.appKey, m![1], "us-east-005", "s3"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  expect(hexOf(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(sts)))).toBe(m![3]);
  expect(JSON.stringify(s.headers)).not.toContain(CFG.appKey);
}

const stream = (b: Uint8Array) => new Response(b).body!;

describe("put", () => {
  it("streams the body with UNSIGNED-PAYLOAD and the declared SHA-256 as x-amz-checksum-sha256", async () => {
    const body = randBytes(1000);
    const sha = await sha256(body);
    const { store, seen } = mock([new Response("", { status: 200 })]);
    expect(await store.put(KEY, stream(body), body.length, sha)).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe(CFG.endpoint + "/bkt/" + KEY);
    expect(seen[0].headers["x-amz-checksum-sha256"]).toBe(b64(sha));
    expect(seen[0].headers["content-type"]).toBe("application/octet-stream");
    expect(seen[0].headers.authorization).toContain("x-amz-checksum-sha256");
    expect(seen[0].body).toEqual(body);
    await checkSigned(seen[0]);
  });

  it("400 BadDigest or IncompleteBody -> mismatch; a cap 403 -> cap; anything else throws", async () => {
    const body = randBytes(10);
    const sha = await sha256(body);
    for (const [res, want] of [
      [xmlErr(400, "BadDigest"), "mismatch"],
      [xmlErr(400, "IncompleteBody"), "mismatch"],
      [xmlErr(403, "AccessDenied", "Cannot upload files, storage cap exceeded."), "cap"],
    ] as const) {
      const { store } = mock([res]);
      expect(await store.put(KEY, stream(body), body.length, sha)).toBe(want);
    }
    for (const res of [xmlErr(403, "AccessDenied", "denied"), xmlErr(500, "InternalError"), xmlErr(400, "InvalidRequest"), new Response("", { status: 503 })]) {
      const { store } = mock([res]);
      await expect(store.put(KEY, stream(body), body.length, sha)).rejects.toBeInstanceOf(B2Error);
    }
  });
});

describe("cap detection", () => {
  it("every B2 cap form is a cap on put, get and lists; any other 403 is not", async () => {
    const body = randBytes(10);
    const sha = await sha256(body);
    const caps = [
      ["AccessDenied", "Cannot upload files, storage cap exceeded."],
      ["AccessDenied", "Cannot download file, download bandwidth or transaction (Class B) cap exceeded."],
      ["AccessDenied", "Transaction cap exceeded"],
      ["storage_cap_exceeded", "x"],
      ["download_cap_exceeded", "x"],
      ["transaction_cap_exceeded", "x"],
      ["CapExceeded", "x"],
    ];
    for (const [code, msg] of caps) {
      expect(await mock([xmlErr(403, code, msg)]).store.put(KEY, stream(body), body.length, sha)).toBe("cap");
      expect(await mock([xmlErr(403, code, msg)]).store.get(KEY, null)).toBe("cap");
      expect(await mock([xmlErr(403, code, msg)]).store.listPrefixes("v1/")).toBe("cap");
    }
    for (const [code, msg] of [["AccessDenied", "Access Denied"], ["InvalidAccessKeyId", "x"], ["AccessDenied", "bucket is not authorized"]]) {
      await expect(mock([xmlErr(403, code, msg)]).store.put(KEY, stream(body), body.length, sha)).rejects.toBeInstanceOf(B2Error);
    }
    await expect(mock([xmlErr(500, "InternalError", "cap exceeded")]).store.get(KEY, null)).rejects.toBeInstanceOf(B2Error);
  });
});

describe("get", () => {
  it("passes a Range and returns status, Content-Range and ETag", async () => {
    const { store, seen } = mock([new Response("abc", { status: 206, headers: { "Content-Range": "bytes 0-2/10", ETag: '"tag"', "Content-Length": "3" } })]);
    const r = await store.get(KEY, "bytes=0-2");
    expect(seen[0].headers.range).toBe("bytes=0-2");
    expect(seen[0].method).toBe("GET");
    await checkSigned(seen[0]);
    if (typeof r === "string" || r.status === 416) throw new Error("not a body");
    expect(r).toMatchObject({ status: 206, length: 3, contentRange: "bytes 0-2/10", etag: '"tag"' });
    expect(await new Response(r.body).text()).toBe("abc");
  });

  it("404 -> missing, 416 -> 416 with the size, cap -> cap, other -> throws", async () => {
    expect(await mock([xmlErr(404, "NoSuchKey")]).store.get(KEY, null)).toBe("missing");
    const r416 = xmlErr(416, "InvalidRange");
    r416.headers.set("Content-Range", "bytes */10");
    expect(await mock([r416]).store.get(KEY, "bytes=99-")).toEqual({ status: 416, size: 10 });
    expect(await mock([xmlErr(416, "InvalidRange")]).store.get(KEY, "bytes=99-")).toEqual({ status: 416, size: null });
    expect(await mock([xmlErr(403, "AccessDenied", "Cannot download file, download bandwidth or transaction (Class B) cap exceeded.")]).store.get(KEY, null)).toBe("cap");
    await expect(mock([xmlErr(401, "UnauthorizedAccess")]).store.get(KEY, null)).rejects.toBeInstanceOf(B2Error);
    await expect(mock([xmlErr(500, "InternalError")]).store.get(KEY, null)).rejects.toBeInstanceOf(B2Error);
  });
});

const versionsPage = (items: [string, string][], next?: [string, string], markers: [string, string][] = []) =>
  new Response(
    "<ListVersionsResult>" +
      `<IsTruncated>${next ? "true" : "false"}</IsTruncated>` +
      (next ? `<NextKeyMarker>${next[0]}</NextKeyMarker><NextVersionIdMarker>${next[1]}</NextVersionIdMarker>` : "") +
      items.map(([k, v]) => `<Version><Key>${k}</Key><VersionId>${v}</VersionId><IsLatest>true</IsLatest></Version>`).join("") +
      markers.map(([k, v]) => `<DeleteMarker><Key>${k}</Key><VersionId>${v}</VersionId></DeleteMarker>`).join("") +
      "</ListVersionsResult>",
    { status: 200 },
  );

describe("lists", () => {
  it("listVersions pages with key and version id markers and returns versions and delete markers", async () => {
    const { store, seen } = mock([versionsPage([["v1/a/x", "4_z1"]], ["v1/a/x", "4_z1"]), versionsPage([["v1/a/y", "4_z2"]], undefined, [["v1/a/y", "4_z3"]])]);
    expect(await store.listVersions("v1/a/")).toEqual([
      { key: "v1/a/x", versionId: "4_z1" },
      { key: "v1/a/y", versionId: "4_z2" },
      { key: "v1/a/y", versionId: "4_z3" },
    ]);
    const u0 = new URL(seen[0].url);
    expect(u0.pathname).toBe("/bkt");
    expect(u0.searchParams.has("versions")).toBe(true);
    expect(u0.searchParams.get("prefix")).toBe("v1/a/");
    const u1 = new URL(seen[1].url);
    expect(u1.searchParams.get("key-marker")).toBe("v1/a/x");
    expect(u1.searchParams.get("version-id-marker")).toBe("4_z1");
    await checkSigned(seen[1]);
  });

  it("listPrefixes pages with the continuation token, delimiter /", async () => {
    const page = (ps: string[], token?: string) =>
      new Response(
        `<ListBucketResult><IsTruncated>${token ? "true" : "false"}</IsTruncated>` +
          (token ? `<NextContinuationToken>${token}</NextContinuationToken>` : "") +
          ps.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("") +
          "</ListBucketResult>",
        { status: 200 },
      );
    const { store, seen } = mock([page(["v1/202612312359/"], "t+/1="), page(["v1/202701010000/"])]);
    expect(await store.listPrefixes("v1/")).toEqual(["v1/202612312359/", "v1/202701010000/"]);
    expect(new URL(seen[0].url).searchParams.get("delimiter")).toBe("/");
    expect(new URL(seen[0].url).searchParams.get("list-type")).toBe("2");
    expect(new URL(seen[1].url).searchParams.get("continuation-token")).toBe("t+/1=");
    await checkSigned(seen[1]);
  });

  it("a cap on a list -> cap", async () => {
    expect(await mock([xmlErr(403, "AccessDenied", "Transaction cap exceeded")]).store.listVersions("v1/")).toBe("cap");
    expect(await mock([xmlErr(403, "AccessDenied", "Transaction cap exceeded")]).store.listPrefixes("v1/")).toBe("cap");
  });
});

describe("remove (every version)", () => {
  it("lists the key's versions and deletes each by version id with Content-MD5", async () => {
    const other = KEY + "0";
    const { store, seen } = mock([versionsPage([[KEY, "v-a"], [KEY, "v-b"], [other, "v-c"]]), new Response("<DeleteResult></DeleteResult>", { status: 200 })]);
    expect(await store.remove(KEY)).toBe("ok");
    expect(new URL(seen[0].url).searchParams.get("prefix")).toBe(KEY);
    const d = seen[1];
    expect(d.method).toBe("POST");
    expect(new URL(d.url).search).toBe("?delete");
    const text = new TextDecoder().decode(d.body!);
    expect(text).toContain(`<Object><Key>${KEY}</Key><VersionId>v-a</VersionId></Object>`);
    expect(text).toContain(`<Object><Key>${KEY}</Key><VersionId>v-b</VersionId></Object>`);
    expect(text).not.toContain("v-c");
    expect(d.headers["content-md5"]).toBe(b64(new Uint8Array(await crypto.subtle.digest("MD5", d.body!))));
    await checkSigned(d);
  });

  it("no version -> missing with no delete call; a per-object error throws; a cap -> cap", async () => {
    const m1 = mock([versionsPage([])]);
    expect(await m1.store.remove(KEY)).toBe("missing");
    expect(m1.seen).toHaveLength(1);
    const m2 = mock([versionsPage([[KEY, "v"]]), new Response("<DeleteResult><Error><Key>k</Key><Code>AccessDenied</Code></Error></DeleteResult>", { status: 200 })]);
    await expect(m2.store.remove(KEY)).rejects.toBeInstanceOf(B2Error);
    expect(await mock([versionsPage([[KEY, "v"]]), xmlErr(403, "AccessDenied", "Transaction cap exceeded")]).store.remove(KEY)).toBe("cap");
  });

  it("deleteVersions sends batches of 1000", async () => {
    const vs = Array.from({ length: 1001 }, (_, i) => ({ key: KEY, versionId: "v" + i }));
    const { store, seen } = mock([new Response("<DeleteResult/>"), new Response("<DeleteResult/>")]);
    expect(await store.deleteVersions(vs)).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(new TextDecoder().decode(seen[0].body!).split("<Object>")).toHaveLength(1001);
    expect(new TextDecoder().decode(seen[1].body!).split("<Object>")).toHaveLength(2);
  });
});
