// Runs tests/vectors/file-v1.json through the file modules, plus the status
// table, the catch-up rule, and the upload and download clients.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { type DownloadDeps, FileError, downloadFile, downloadHeaders, fileUrlOk, uploadFile, uploadHeaders } from "../src/api/file.ts";
import { b64urlDecode, b64urlEncode } from "../src/crypto/b64url.ts";
import { buf, utf8, utf8Decode } from "../src/crypto/bytes.ts";
import { BLOB_OVERHEAD, MAX_FILE, openFile, sealFile } from "../src/crypto/filecrypt.ts";
import { importPrivate, verify } from "../src/crypto/keys.ts";
import { downloadSignedBytes, fileSignedBytes } from "../src/crypto/pasig.ts";
import { Sha256, sha256Blob } from "../src/crypto/sha256.ts";
import { collide, sanitizeName } from "../src/model/filename.ts";
import { DEFAULT_PICKER, PICKER_SIZES, autoDownload, catchUpDue, enoughStorage, fileStatus, fileWait, storageFullText } from "../src/model/filerules.ts";
import { type FileValue, buildJson, parseInnerJson } from "../src/model/message.ts";
import { FileStore, done } from "../src/store/files.ts";

type Any = any;
const root = join(import.meta.dirname, "..", "..", "..", "tests", "vectors");
const V: Any = JSON.parse(readFileSync(join(root, "file-v1.json"), "utf8"));
const G: Any = JSON.parse(readFileSync(join(root, "golden-v1.json"), "utf8"));
const d = b64urlDecode;

test("file-v1 constants", () => {
  assert.equal(MAX_FILE, V.constants.MAX_FILE);
  assert.equal(BLOB_OVERHEAD, V.constants.BLOB_OVERHEAD);
});

test("file-v1 sha256: pure SHA-256 in any split", async () => {
  for (const c of V.sha256.cases) {
    const input = d(c.input);
    assert.equal(b64urlEncode(new Sha256().update(input).digest()), c.sha256, c.name);
    const h = new Sha256();
    for (let i = 0; i < input.length; i += 7) h.update(input.subarray(i, i + 7));
    assert.equal(b64urlEncode(h.digest()), c.sha256, c.name + " in pieces");
    assert.equal(await sha256Blob(new Blob([buf(input)])), c.sha256);
  }
  // lengths around the 55/56/64 padding edges, odd splits
  const data = new Uint8Array(300).map((_, i) => (i * 131 + 7) & 255);
  for (let n = 0; n < data.length; n++) {
    const h = new Sha256();
    const cut = n % 67;
    h.update(data.subarray(0, Math.min(cut, n))).update(data.subarray(Math.min(cut, n), n));
    assert.equal(b64urlEncode(h.digest()), createHash("sha256").update(data.subarray(0, n)).digest("base64url"), "len " + n);
  }
});

test("file-v1 blob: seal, open, sha256, any flipped bit fails", async () => {
  for (const c of V.blob.cases) {
    const key = d(c.key);
    const sealed = await sealFile(key, d(c.plaintext), d(c.nonce));
    assert.ok(sealed instanceof Blob);
    const blob = new Uint8Array(await sealed.arrayBuffer());
    assert.equal(b64urlEncode(blob), c.blob, c.name);
    assert.equal(blob.length, c.size + BLOB_OVERHEAD);
    assert.equal(blob.length, c.blob_size);
    assert.deepEqual(await openFile(key, d(c.blob)), d(c.plaintext));
    assert.equal(await sha256Blob(new Blob([buf(blob)])), c.sha256);
    for (const bit of [0, 8 * 12, blob.length * 8 - 1, Math.floor((blob.length * 8) / 2)]) {
      const bad = blob.slice();
      bad[bit >> 3]! ^= 1 << (bit & 7);
      assert.equal(await openFile(key, bad), null, c.name + " bit " + bit);
    }
  }
  assert.equal(await openFile(new Uint8Array(32), new Uint8Array(27)), null);
});

test("file-v1 file_sig: signed bytes and signatures", async () => {
  for (const c of V.file_sig.cases) {
    const path = c.method === "POST" ? "/v1/file" : "/v1/file/" + c.id;
    const b = fileSignedBytes(c.method, path, c.pa_time, c.method === "POST" ? { length: c.content_length, sha256: c.file_sha256, sendId: c.send_id } : undefined);
    assert.equal(b64urlEncode(b), c.signed_bytes, c.name);
    assert.equal(utf8Decode(b), c.signed_text, c.name);
    assert.equal(await verify(d(c.sign_pub), d(c.sig), b), c.verifies, c.name);
  }
});

test("file-v1 download_sig: signed bytes, headers and signatures", async () => {
  const X = G.keys.peers.X;
  const signer = { id: X.id, key: (await importPrivate("ECDSA", d(X.sign_priv), d(X.sign_pub))).privateKey, signPub: X.sign_pub, encPub: X.enc_pub };
  assert.equal(V.download_sig.cases.length, 3);
  for (const c of V.download_sig.cases) {
    assert.equal(c.path, new URL(c.url).pathname, c.name);
    const b = downloadSignedBytes(c.path, c.pa_time);
    assert.equal(b64urlEncode(b), c.signed_bytes, c.name);
    assert.equal(utf8Decode(b), c.signed_text, c.name);
    assert.equal(await verify(d(c.sign_pub), d(c.sig), b), c.verifies, c.name);
    const h = await downloadHeaders(signer, c.pa_time, c.path);
    assert.deepEqual(Object.keys(h).sort(), Object.keys(c.headers).sort(), c.name);
    for (const k of ["PA-ID", "PA-Time", "PA-Sign-Pub", "PA-Enc-Pub"]) assert.equal(h[k], c.headers[k], c.name + " " + k);
    assert.equal(h["PA-Sig"]!.length, 86);
    assert.ok(await verify(d(c.sign_pub), d(h["PA-Sig"]!), b), c.name);
  }
});

test("file-v1 upload_request: headers from the body", async () => {
  const u = V.upload_request;
  const body = d(u.body);
  const X = G.keys.peers.X;
  const key = (await importPrivate("ECDSA", d(X.sign_priv), d(X.sign_pub))).privateKey;
  const sha = await sha256Blob(new Blob([buf(body)]));
  const h = await uploadHeaders(u.headers["PA-Client"], { id: X.id, key }, u.headers["PA-Time"], body.length, sha, u.headers["PA-Send-ID"]);
  for (const k of ["PA-Client", "PA-ID", "PA-Time", "PA-File-SHA256", "PA-Send-ID"]) assert.equal(h[k], u.headers[k], k);
  assert.equal(h["Content-Length"], String(u.headers["Content-Length"]));
  const signed = fileSignedBytes("POST", u.path, h["PA-Time"]!, { length: body.length, sha256: sha, sendId: h["PA-Send-ID"]! });
  assert.equal(b64urlEncode(signed), u.signed_bytes);
  assert.ok(await verify(d(u.sign_pub), d(h["PA-Sig"]!), signed));
  assert.ok(await verify(d(u.sign_pub), d(u.headers["PA-Sig"]), signed));
  assert.deepEqual(await openFile(d(u.key), body), d(u.plaintext));
});

test("file-v1 names and collisions", () => {
  for (const c of V.names.cases) assert.equal(sanitizeName(c.input, V.names.time, c.image), c.output, JSON.stringify(c.input));
  // the browser picks the saved name and settles conflicts; collide is the ignore_case mode
  for (const c of V.collision.cases.filter((c: { mode: string }) => c.mode === "ignore_case")) assert.equal(collide(c.input, c.existing), c.output, c.name);
});

test("file-v1 auto_download: browser and cli rows", () => {
  assert.deepEqual(PICKER_SIZES, [0, 10_000_000, 25_000_000, 50_000_000, 100_000_000]);
  assert.equal(DEFAULT_PICKER, 50_000_000);
  let n = 0;
  for (const c of V.auto_download.cases) {
    if (c.client === "phone") continue;
    const picker = c.client === "cli" ? MAX_FILE : c.picker;
    assert.equal(autoDownload(picker, c.size), c.download, JSON.stringify(c));
    n++;
  }
  assert.ok(n >= 48);
  // catch-up never starts at or after expires by the local clock
  assert.equal(catchUpDue({ size: 1, expires: 1000 }, DEFAULT_PICKER, 999), true);
  assert.equal(catchUpDue({ size: 1, expires: 1000 }, DEFAULT_PICKER, 1000), false);
  assert.equal(catchUpDue({ size: 60_000_000, expires: 1000 }, DEFAULT_PICKER, 1), false);
});

test("status table, upload and download", () => {
  const rows: [string, "upload" | "download", number, Record<string, unknown>, string, string | null][] = [
    ["quota", "upload", 429, { error: "file quota", retry_after: 3599 }, "final:quota", "You reached your file limit. Try again in 1 hour"],
    ["quota hours", "download", 429, { error: "file quota", retry_after: 3600 }, "final:quota", "You reached your file limit. Try again in 1 hour"],
    ["quota no wait", "upload", 429, { error: "file quota" }, "final:quota", "You reached your file limit. Try again later"],
    ["rate limited", "upload", 429, { error: "rate limited", retry_after: 12 }, "retry", null],
    ["paused known end", "upload", 503, { error: "files paused", retry_after: 172800 }, "final:paused", "File sending is over quota and paused for 2 days"],
    ["paused days", "download", 503, { error: "files paused", retry_after: 172799 }, "final:paused", "File sending is over quota and paused for 2 days"],
    ["paused no end", "upload", 503, { error: "files paused" }, "final:paused", "File sending is paused. Try again later"],
    ["502", "download", 502, {}, "retry", null],
    ["503 other", "upload", 503, {}, "retry", null],
    ["no reply", "download", 0, {}, "retry", null],
    ["413", "upload", 413, { error: "too large" }, "final:too_large", null],
    ["403", "upload", 403, { error: "unapproved" }, "final:failed", null],
    ["426", "upload", 426, { error: "update required" }, "final:update", null],
    ["410", "download", 410, {}, "final:expired", "Expired"],
    ["update", "download", 404, { error: "update required" }, "final:update", "Update the app"],
    ["404 before expires", "download", 404, {}, "final:deleted", "Deleted"],
    ["404 at expires", "download", 404, {}, "final:expired", "Expired"],
    ["403 download", "download", 403, {}, "final:failed", "Download failed"],
  ];
  for (const [name, op, status, json, kind, text] of rows) {
    const o = fileStatus(op, status, json, name === "404 before expires" ? 999 : 1000, 1000);
    assert.equal(o.kind === "final" ? "final:" + o.code : "retry", kind, name);
    if (o.kind === "final") assert.equal(o.text, text, name);
  }
  assert.deepEqual(fileStatus("upload", 429, { error: "rate limited", retry_after: 12 }), { kind: "retry", wait: 12 });
  assert.equal(fileWait(1), "1 minute");
  assert.equal(fileWait(3540), "59 minutes");
  assert.equal(fileWait(3541), "1 hour");
  assert.equal(fileWait(3601), "2 hours");
  assert.equal(fileWait(169200), "47 hours");
  assert.equal(fileWait(169201), "2 days");
  assert.equal(fileWait(86400 * 3), "3 days");
  assert.equal(storageFullText("download", "a.pdf"), 'Not enough storage to download "a.pdf"');
  assert.equal(storageFullText("upload", "a.pdf"), 'Not enough storage to send "a.pdf"');
  assert.equal(enoughStorage(null, MAX_FILE), true);
  assert.equal(enoughStorage(2 * 1000 + 10_000_000, 1000), true);
  assert.equal(enoughStorage(2 * 1000 + 9_999_999, 1000), false);
});

const FV: FileValue = {
  url: "https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-0123456789abcdef0123456789abcdef",
  expires: 1795405632,
  key: V.blob.cases[1].key,
  name: "report (1).pdf",
  size: 1234567,
  sha256: V.blob.cases[1].sha256,
};

test("file message: build and parse", () => {
  const j = buildJson(44, { type: "file", value: FV, id: "dG9wc2VjcmV0aWQxMjM0NQ" });
  assert.equal(
    j,
    '{"v":1,"n":44,"id":"dG9wc2VjcmV0aWQxMjM0NQ","show":true,"file":{"url":"' + FV.url + '","expires":1795405632,"key":"' + FV.key + '","name":"report (1).pdf","size":1234567,"sha256":"' + FV.sha256 + '"}}',
  );
  assert.deepEqual(parseInnerJson(utf8(j))?.content, { type: "file", value: FV, id: "dG9wc2VjcmV0aWQxMjM0NQ" });
  const withSize0 = { ...FV, size: 0, extra: 1 };
  assert.deepEqual(parseInnerJson(utf8('{"n":1,"file":' + JSON.stringify(withSize0) + "}"))?.content, { type: "file", value: { ...FV, size: 0 } });
  const bad: Record<string, unknown>[] = [
    { ...FV, size: -1 },
    { ...FV, size: 1.5 },
    { ...FV, size: "1" },
    { ...FV, expires: 2 ** 53 },
    { ...FV, key: FV.key.slice(1) },
    { ...FV, sha256: FV.sha256 + "A" },
    { ...FV, url: 5 },
    { ...FV, name: null },
  ];
  for (const b of bad) assert.equal(parseInnerJson(utf8('{"n":1,"file":' + JSON.stringify(b) + "}")), null, JSON.stringify(b));
  const { name: _n, ...noName } = FV;
  assert.equal(parseInnerJson(utf8('{"n":1,"file":' + JSON.stringify(noName) + "}")), null);
});

test("file URLs", () => {
  assert.ok(fileUrlOk(FV.url));
  assert.ok(fileUrlOk("https://b2file.pusharmor.com:443/v1/x"));
  for (const u of ["http://b2file.pusharmor.com/x", "https://pusharmor.com.evil.example/x", "https://b2file.pusharmor.com:8443/x", "https://u:p@b2file.pusharmor.com/x", "nope"])
    assert.equal(fileUrlOk(u), false, u);
});

// ---- clients ----

function deps(responses: (Response | Error)[], calls: { url: string; init: RequestInit }[]): DownloadDeps & { offset: number; slept: number[] } {
  const o = {
    client: "chrome/0.0.55",
    offset: 0,
    slept: [] as number[],
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error("no more replies");
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => 1795319232123,
    sleep: async (ms: number) => void o.slept.push(ms),
    getOffset: async () => o.offset,
    setOffset: async (s: number) => void (o.offset = s),
    freeBytes: async () => null as number | null,
  };
  return o;
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

async function signer() {
  const X = G.keys.peers.X;
  return { id: X.id as string, key: (await importPrivate("ECDSA", d(X.sign_priv), d(X.sign_pub))).privateKey };
}

const XP = G.keys.peers.X;
const DL = { id: XP.id as string, key: (await importPrivate("ECDSA", d(XP.sign_priv), d(XP.sign_pub))).privateKey, signPub: XP.sign_pub as string, encPub: XP.enc_pub as string };

const OK201 = { id: "202611230347-0123456789abcdef0123456789abcdef", expires: 1795405632, url: FV.url, quota: {} };

test("upload: 2 automatic retries, signed again, one PA-Send-ID", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const dd = deps([new Error("net"), jsonRes(502, {}), jsonRes(201, OK201)], calls);
  const blob = new Blob([new Uint8Array(40)]);
  const sha = await sha256Blob(blob);
  const r = await uploadFile(dd, await signer(), blob, sha, "I-xwGS2DtHwwWlinkK6-dQ", null);
  assert.equal(r.url, FV.url);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    const h = c.init.headers as Record<string, string>;
    assert.equal(h["PA-Send-ID"], "I-xwGS2DtHwwWlinkK6-dQ");
    assert.equal(h["Content-Length"], undefined);
    assert.equal(c.url, "https://api.pusharmor.com/v1/file");
  }
  assert.deepEqual(dd.slept, [1000, 3000]);
  // a third failure is final
  const dd2 = deps([jsonRes(500, {}), jsonRes(429, { error: "rate limited", retry_after: 5 }), jsonRes(500, {})], []);
  await assert.rejects(uploadFile(dd2, await signer(), blob, sha, "I-xwGS2DtHwwWlinkK6-dQ"), (e: FileError) => e.code === "failed" && e.status === 500);
  assert.deepEqual(dd2.slept, [1000, 5000]);
  // quota and pause are final at once
  const dd3 = deps([jsonRes(429, { error: "file quota", retry_after: 7200 })], []);
  await assert.rejects(uploadFile(dd3, await signer(), blob, sha, "I-xwGS2DtHwwWlinkK6-dQ"), (e: FileError) => e.code === "quota" && e.text === "You reached your file limit. Try again in 2 hours");
  // clock skew: signed again with the new offset, not counted
  const calls4: { url: string; init: RequestInit }[] = [];
  const dd4 = deps([jsonRes(401, { error: "clock skew" }, { "PA-Epoch": "1795319532" }), jsonRes(201, OK201)], calls4);
  await uploadFile(dd4, await signer(), blob, sha, "I-xwGS2DtHwwWlinkK6-dQ");
  assert.equal((calls4[1]!.init.headers as Record<string, string>)["PA-Time"], String(1795319232123 + 300_000));
  // the url of an earlier 201 of the same send is used again before it expires
  const prior = { ...r };
  const dd5 = deps([], []);
  assert.equal(await uploadFile(dd5, await signer(), blob, sha, prior.sendId, prior), prior);
  const dd6 = deps([jsonRes(201, OK201)], []);
  await uploadFile(dd6, await signer(), blob, sha, "other_send_id_22chars_", prior);
});

test("download: Range resume, sha256 check, one re-download", async () => {
  const store = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const key = new Uint8Array(32).fill(3);
  const plain = new Uint8Array(5000).map((_, i) => i & 255);
  const blob = new Uint8Array(await (await sealFile(key, plain)).arrayBuffer());
  const sha = await sha256Blob(new Blob([buf(blob)]));
  const f = { url: FV.url, expires: 1795405632, name: "a.bin", size: plain.length, sha256: sha };
  let sent = false;
  // first reply is cut off after 1000 bytes, then a 206 from byte 1000
  const cut = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent) return c.error(new Error("cut"));
      sent = true;
      c.enqueue(blob.subarray(0, 1000));
    },
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const dd = deps(
    [new Response(cut, { status: 200 }), new Response(buf(blob).subarray(1000), { status: 206, headers: { "Content-Range": "bytes 1000-" + (blob.length - 1) + "/" + blob.length } })],
    calls,
  );
  const tries = { n: 0 };
  const got = await downloadFile(dd, DL, store, "r1", f, tries);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), blob);
  assert.equal((calls[1]!.init.headers as Record<string, string>).Range, "bytes=1000-");
  assert.equal(tries.n, 1);
  assert.deepEqual(await openFile(key, new Uint8Array(await got.arrayBuffer())), plain);
  await store.clear("r1");
  assert.equal(await store.size("r1"), 0);

  // a damaged blob twice: one re-download, then damaged
  const bad = blob.slice();
  bad[100]! ^= 1;
  const calls2: { url: string; init: RequestInit }[] = [];
  const dd2 = deps([new Response(buf(bad), { status: 200 }), new Response(buf(bad), { status: 200 })], calls2);
  await assert.rejects(downloadFile(dd2, DL, store, "r2", f, { n: 0 }), (e: FileError) => e.code === "damaged" && e.text === "Unable to open this file. It is not valid or was damaged.");
  assert.equal(calls2.length, 2);
  assert.equal(await store.size("r2"), 0);
  // damaged once, then good
  const dd3 = deps([new Response(buf(bad), { status: 200 }), new Response(buf(blob), { status: 200 })], []);
  assert.equal((await downloadFile(dd3, DL, store, "r3", f, { n: 0 })).size, blob.length);

  // 404 before expires -> Deleted; 410 -> Expired
  await assert.rejects(downloadFile(deps([jsonRes(404, {})], []), DL, store, "r4", f, { n: 0 }), (e: FileError) => e.code === "deleted");
  await assert.rejects(downloadFile(deps([jsonRes(410, {})], []), DL, store, "r4", f, { n: 0 }), (e: FileError) => e.text === "Expired");
  // retries: 5 automatic attempts per file in all
  const t5 = { n: 3 };
  await assert.rejects(downloadFile(deps([jsonRes(502, {}), jsonRes(502, {})], []), DL, store, "r5", f, t5), (e: FileError) => e.code === "failed" && e.text === "Download failed");
  assert.equal(t5.n, 5);
  // not enough storage: final, no request
  const calls6: { url: string; init: RequestInit }[] = [];
  const dd6 = deps([], calls6);
  dd6.freeBytes = async () => 2 * f.size + 9_999_999;
  await assert.rejects(downloadFile(dd6, DL, store, "r6", f, { n: 0 }), (e: FileError) => e.code === "storage" && e.text === 'Not enough storage to download "a.bin"');
  assert.equal(calls6.length, 0);
  // a bad URL never gets a request
  await assert.rejects(downloadFile(deps([], []), DL, store, "r7", { ...f, url: "https://example.com/x" }, { n: 0 }), (e: FileError) => e.code === "damaged");

  // final errors drop the partial blob: Deleted, Expired, storage full, tries used up
  const part = (k = "r8") => store.append(k, new Blob([buf(blob.subarray(0, 100))]));
  await part();
  await assert.rejects(downloadFile(deps([jsonRes(404, {})], []), DL, store, "r8", f, { n: 0 }), (e: FileError) => e.code === "deleted");
  assert.equal(await store.size("r8"), 0);
  await part();
  await assert.rejects(downloadFile(deps([jsonRes(410, {})], []), DL, store, "r8", f, { n: 0 }), (e: FileError) => e.code === "expired");
  assert.equal(await store.size("r8"), 0);
  await part();
  await assert.rejects(downloadFile(dd6, DL, store, "r8", f, { n: 0 }), (e: FileError) => e.code === "storage");
  assert.equal(await store.size("r8"), 0);
  await part();
  await assert.rejects(downloadFile(deps([jsonRes(502, {})], []), DL, store, "r8", f, { n: 4 }), (e: FileError) => e.code === "failed");
  assert.equal(await store.size("r8"), 0);

  // 416: the stored part does not fit the object; start again once
  await part("r9");
  const calls9: { url: string; init: RequestInit }[] = [];
  assert.equal((await downloadFile(deps([new Response("", { status: 416 }), new Response(buf(blob), { status: 200 })], calls9), DL, store, "r9", f, { n: 0 })).size, blob.length);
  assert.equal((calls9[0]!.init.headers as Record<string, string>).Range, "bytes=100-");
  assert.equal((calls9[1]!.init.headers as Record<string, string>).Range, undefined);
  // a whole reply that is too short, twice: damaged, no resume
  const short = () => new Response(buf(blob.subarray(0, 50)), { status: 200 });
  const calls10: { url: string; init: RequestInit }[] = [];
  await assert.rejects(downloadFile(deps([short(), short()], calls10), DL, store, "r10", f, { n: 0 }), (e: FileError) => e.code === "damaged" && e.text === "Unable to open this file. It is not valid or was damaged.");
  assert.equal(calls10.length, 2);
  assert.equal(await store.size("r10"), 0);
  // a redirect off the file hosts: damaged, the body is not stored
  const moved = new Response(buf(blob), { status: 200 });
  Object.defineProperty(moved, "url", { value: "https://example.com/x" });
  await assert.rejects(downloadFile(deps([moved], []), DL, store, "r11", f, { n: 0 }), (e: FileError) => e.code === "damaged");
  assert.equal(await store.size("r11"), 0);

  // a full disk while storing: the storage-full text, and no partial blob
  const full = Object.create(store) as FileStore;
  full.append = async () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  await part();
  await assert.rejects(downloadFile(deps([new Response(buf(blob), { status: 200 })], []), DL, full, "r8", f, { n: 0 }), (e: FileError) => e.code === "storage" && e.text === 'Not enough storage to download "a.bin"');
  assert.equal(await store.size("r8"), 0);
  store.close();
});

test("download: every request signed (PA-DL1), a fresh PA-Time on each retry and Range resume; refusals", async () => {
  const store = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const blob = new Uint8Array(await (await sealFile(new Uint8Array(32).fill(4), new Uint8Array(3000))).arrayBuffer());
  const f = { url: FV.url, expires: 1795405632, name: "a.bin", size: 3000, sha256: await sha256Blob(new Blob([buf(blob)])) };
  const path = new URL(FV.url).pathname;
  let sent = false;
  const cut = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent) return c.error(new Error("cut"));
      sent = true;
      c.enqueue(blob.subarray(0, 1000));
    },
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const dd = deps([jsonRes(502, {}), new Response(cut, { status: 200 }), new Response(buf(blob).subarray(1000), { status: 206, headers: { "Content-Range": "bytes 1000-" + (blob.length - 1) + "/" + blob.length } })], calls);
  let now = 1795319232123;
  dd.now = () => (now += 7);
  await downloadFile(dd, DL, store, "s1", f, { n: 0 });
  assert.equal(calls.length, 3);
  const times = new Set<string>();
  for (const [i, c] of calls.entries()) {
    const h = c.init.headers as Record<string, string>;
    assert.equal(h["PA-ID"], XP.id);
    assert.equal(h["PA-Sign-Pub"], XP.sign_pub);
    assert.equal(h["PA-Enc-Pub"], XP.enc_pub);
    assert.match(h["PA-Time"]!, /^[0-9]{13}$/);
    times.add(h["PA-Time"]!);
    assert.ok(await verify(d(XP.sign_pub), d(h["PA-Sig"]!), downloadSignedBytes(path, h["PA-Time"]!)), "request " + i);
    assert.equal(h.Range, i === 2 ? "bytes=1000-" : undefined);
  }
  assert.equal(times.size, 3, "a fresh PA-Time on each request");
  await store.clear("s1");

  // clock skew: signed again with the corrected offset, not one of the tries; a second one is final
  const calls2: { url: string; init: RequestInit }[] = [];
  const dd2 = deps([jsonRes(401, { error: "clock skew" }, { "PA-Epoch": "1795319532" }), new Response(buf(blob), { status: 200 })], calls2);
  const t2 = { n: 0 };
  await downloadFile(dd2, DL, store, "s2", f, t2);
  assert.equal(t2.n, 0);
  assert.equal((calls2[1]!.init.headers as Record<string, string>)["PA-Time"], String(1795319232123 + 300_000));
  await store.clear("s2");
  const skew = () => jsonRes(401, { error: "clock skew" });
  await assert.rejects(downloadFile(deps([skew(), skew()], []), DL, store, "s3", f, { n: 0 }), (e: FileError) => e.code === "failed" && e.text === "Download failed" && e.status === 401);

  // a device of another account, or a refused signature: Download failed at once
  const calls4: { url: string; init: RequestInit }[] = [];
  await assert.rejects(downloadFile(deps([jsonRes(403, { error: "wrong account" })], calls4), DL, store, "s4", f, { n: 0 }), (e: FileError) => e.code === "failed" && e.text === "Download failed" && e.status === 403 && e.error === "wrong account");
  assert.equal(calls4.length, 1);
  await assert.rejects(downloadFile(deps([jsonRes(401, { error: "invalid client signature" })], []), DL, store, "s4", f, { n: 0 }), (e: FileError) => e.code === "failed" && e.text === "Download failed" && e.status === 401);
  store.close();
});

test("file store: a failed request rejects with its own error", async () => {
  const f = new IDBFactory();
  await FileStore.open(f, IDBKeyRange);
  const db = await new Promise<IDBDatabase>((res) => {
    const r = f.open("pusharmor-files");
    r.onsuccess = () => res(r.result);
  });
  const tx = db.transaction("picked", "readwrite");
  tx.objectStore("picked").add(new Blob(["a"]), "k");
  tx.objectStore("picked").add(new Blob(["b"]), "k");
  await assert.rejects(done(tx), (e: DOMException) => e.name === "ConstraintError");
  db.close();
});

test("file store: picked files and clear all", async () => {
  const store = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const k = await store.putPicked(new Blob(["abc"]));
  assert.equal(await (await store.picked(k))!.text(), "abc");
  await store.append("x", new Blob(["12"]));
  await store.append("x", new Blob(["34"]));
  assert.equal(await (await store.blob("x")).text(), "1234");
  await store.clearAll();
  assert.equal(await store.picked(k), null);
  assert.equal(await store.size("x"), 0);
  store.close();
});
