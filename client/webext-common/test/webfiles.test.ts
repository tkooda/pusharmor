// Chrome and Firefox file sending: the History file rows, the decrypt mark, page
// images in 8 MB pieces up to 10,000,000 bytes, the send and receive paths through the
// engine, and the manifest permissions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { type FileHost, Files, HostGone, fileKey, fileOpenFailed, sendFileError } from "../src/core/files.ts";
import type { JobReq } from "../src/core/fileworker.ts";
import { FileWorker } from "../src/core/fileworker.ts";
import { sealFile } from "../src/crypto/filecrypt.ts";
import { sendingCaption } from "../src/model/busy.ts";
import { b64urlEncode } from "../src/crypto/b64url.ts";
import { sha256Blob } from "../src/crypto/sha256.ts";
import * as F from "../src/model/filerow.ts";
import { IMAGE_CAP, ImageCollector, PIECE_B64, PIECE_RAW, collectImage, onImagePort, pageImageFetch } from "../src/model/imgfetch.ts";
import type { FileValue } from "../src/model/message.ts";
import type { HistoryRow } from "../src/store/db.ts";
import { FileStore } from "../src/store/files.ts";
import { Clock, MockWorker, deliver, device, pairAndApprove } from "./harness.ts";

const NOW = 1_795_400_000;
const H = 3600;

// ---- rows ----

test("file row: Download with the expiry right of it, progress, decrypting, ready, and the final errors", () => {
  const exp = NOW + 23 * H;
  const st = (s: F.FileState, running = false, pct = 0, here = false, e = exp) => F.fileRowStatus(s, running, pct, here, e, NOW);
  assert.deepEqual(st({}), { k: "pending", expires: "expires in 23 h" });
  assert.deepEqual(st({}, false, 0, false, NOW + 40 * 60), { k: "pending", expires: "expires in 40 min" });
  assert.deepEqual(st({}, true, 45.7), { k: "downloading", pct: 45 });
  assert.deepEqual(st({ got: true }), { k: "decrypting" });
  assert.deepEqual(st({ plain: true, image: true }, false, 0, true), { k: "ready" });
  // the decrypted file went for space: grey line, Download again while not expired
  assert.deepEqual(st({ plain: true }), { k: "failed", text: "Removed from this device", download: true, expires: "expires in 23 h", grey: true });
  assert.deepEqual(st({ plain: true }, false, 0, false, NOW), { k: "failed", text: "Removed from this device", download: false, expires: null, grey: true });
  assert.deepEqual(st({ mem: true, got: true }), { k: "memory" });
  assert.deepEqual(st({ code: "expired", text: "Expired" }), { k: "expired" });
  assert.deepEqual(st({}, false, 0, false, NOW), { k: "expired" }, "past expires by the local clock and not here");
  assert.deepEqual(st({ code: "deleted", text: "Deleted" }), { k: "failed", text: "Deleted", download: false, expires: null });
  assert.deepEqual(st({ code: "damaged", text: "Unable to open this file. It is not valid or was damaged." }).k, "failed");
  assert.deepEqual(st({ code: "failed", text: "Download failed" }), { k: "failed", text: "Download failed", download: true, expires: "expires in 23 h" });
  assert.deepEqual(st({ code: "storage", text: 'Not enough storage to download "a.pdf"' }), { k: "failed", text: 'Not enough storage to download "a.pdf"', download: true, expires: "expires in 23 h" });
});

test("file row buttons: an image has View, Copy (where the clipboard takes images), and Save; any other file only Save; never Open or Share", () => {
  assert.deepEqual(F.fileActions({ plain: true, image: true }, true), ["view", "copy", "save"]);
  assert.deepEqual(F.fileActions({ plain: true, image: true }, false), ["view", "save"]);
  assert.deepEqual(F.fileActions({ plain: true }, true), ["save"]);
  assert.equal(F.previewMissing("photo.heic", { plain: true }), true);
  assert.equal(F.previewMissing("photo.png", { plain: true, image: true }), false);
  assert.equal(F.previewMissing("doc.pdf", { plain: true }), false);
});

test("file row text: sizes, types, and the name a receiver shows", () => {
  assert.deepEqual([F.sizeText(512), F.sizeText(840_000), F.sizeText(999_600), F.sizeText(2_100_000), F.sizeText(100_000_000)], ["512 bytes", "840 KB", "1.0 MB", "2.1 MB", "100.0 MB"]);
  assert.deepEqual(["a.jpg", "a.pdf", "a.txt", "a.m4a", "a.mp4", "a.zip", "a.dwg", "a"].map(F.typeLabel), ["JPEG image", "PDF", "Text", "M4A audio", "MP4 video", "ZIP archive", "DWG file", "File"]);
  assert.equal(F.detail("report.pdf", 2_100_000), "2.1 MB - PDF");
  assert.equal(F.receivedName("../x/<rep>.pdf", NOW * 1000), "_rep_.pdf");
  assert.equal(F.expiresText(NOW, NOW), "Expired");
});

test("settings: one auto-download picker Off to 100 MB (default 50 MB), the helper text, and the storage limit that fits", () => {
  assert.deepEqual([0, 10_000_000, 25_000_000, 50_000_000, 100_000_000].map(F.pickerLabel), ["Off", "Up to 10 MB", "Up to 25 MB", "Up to 50 MB", "Up to 100 MB"]);
  assert.equal(F.pickerValue(undefined), 50_000_000);
  assert.equal(F.pickerValue(7), 50_000_000);
  assert.equal(F.HELPER, "Larger files expire sooner, between 1 and 24 hours after they are sent");
  assert.equal(F.STORAGE_TITLE, "Storage for received files");
  assert.equal(F.STORAGE_HELPER, "When full, the oldest files are removed from this device");
  assert.deepEqual(F.storageOptions(null).map(F.storageLabel), ["100 MB", "500 MB", "1 GB", "5 GB"]);
  assert.deepEqual(F.storageOptions(2_000_000_000), [100_000_000, 500_000_000, 1_000_000_000]);
  assert.deepEqual(F.storageOptions(1), [100_000_000]);
  assert.equal(F.storageLimit(undefined, null), 500_000_000);
  assert.equal(F.storageLimit(5_000_000_000, 2_000_000_000), 1_000_000_000, "the largest choice that fits");
  // oldest first, the newest always stays
  const files = [{ key: "a", at: 1, bytes: 60 }, { key: "b", at: 2, bytes: 60 }, { key: "c", at: 3, bytes: 200 }];
  assert.deepEqual(F.toRemove(files, 100), ["a", "b"]);
  assert.deepEqual(F.toRemove(files, 1000), []);
});

test("page image names: the URL's last segment, the extension from the bytes, else the Content-Type", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(F.webImageName("https://ex.com/a/cat%20pic.jpg?x=1", png, "image/jpeg", NOW), "cat pic.png");
  assert.equal(F.webImageName("https://ex.com/photo.jpeg", jpg, "", NOW), "photo.jpeg");
  assert.equal(F.webImageName("https://ex.com/img", new Uint8Array(4), "image/webp", NOW), "img.webp");
  assert.equal(F.webImageName("data:image/gif;base64,R0lG", new Uint8Array(4), "", NOW), "image-20261123-021320.gif");
  assert.equal(F.sniffImage(png), "png");
  assert.equal(F.sniffImage(new TextEncoder().encode("<svg xmlns")), null, "svg is a file, never shown");
});

// ---- page images ----

/** Runs pageImageFetch from its source text alone (as an injected script runs), with a fake fetch and port. */
async function runInjected(bytes: number, withLength: boolean): Promise<unknown[]> {
  const got: unknown[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: g.fetch, chrome: g.chrome };
  let ended: () => void = () => undefined;
  const end = new Promise<void>((r) => (ended = r));
  g.chrome = { runtime: { connect: () => ({ postMessage: (m: Record<string, unknown>) => { got.push(m); if (!("b64" in m)) ended(); } }) } };
  g.fetch = async () => {
    let left = bytes;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!left) return c.close();
        const n = Math.min(left, 1_000_000);
        left -= n;
        c.enqueue(new Uint8Array(n).fill(7));
      },
    });
    return new Response(body, { headers: withLength ? { "content-type": "image/png", "content-length": String(bytes) } : { "content-type": "image/png" } });
  };
  try {
    const fn = new Function("return (" + pageImageFetch.toString() + ")")() as typeof pageImageFetch;
    fn("https://ex.com/a.png", "pa-img:x", IMAGE_CAP, PIECE_RAW);
    await end;
  } finally {
    g.fetch = saved.fetch;
    g.chrome = saved.chrome;
  }
  return got;
}

test("page image: bytes come in base64 pieces of at most 8 MB and join to the same bytes", async () => {
  const msgs = await runInjected(9_500_000, true);
  const pieces = msgs.filter((m) => typeof (m as { b64?: unknown }).b64 === "string") as { b64: string }[];
  assert.deepEqual(pieces.map((p) => p.b64.length), [PIECE_B64, 4_666_668]);
  assert.deepEqual(msgs.at(-1), { done: true, type: "image/png" });
  const c = new ImageCollector();
  const res = msgs.map((m) => c.add(m));
  assert.deepEqual(res, ["more", "more", "done"]);
  assert.equal(c.blob().size, 9_500_000);
});

test("page image: over 10,000,000 bytes it stops (from Content-Length, or while reading) and the image URL goes instead", async () => {
  assert.equal(IMAGE_CAP, 10_000_000);
  assert.deepEqual(await runInjected(IMAGE_CAP + 1, true), [{ over: true }]);
  const read = await runInjected(IMAGE_CAP + 1, false);
  assert.deepEqual(read.at(-1), { over: true });
  assert.ok(read.length <= Math.ceil(IMAGE_CAP / PIECE_RAW) + 1);
  // exactly 10,000,000 bytes are taken
  const ok = await runInjected(IMAGE_CAP, false);
  assert.deepEqual(ok.at(-1), { done: true, type: "image/png" });
  // the background refuses a piece over 8 MB and a total over 10,000,000 bytes
  assert.equal(new ImageCollector().add({ b64: "A".repeat(PIECE_B64 + 4) }), "failed");
  const c = new ImageCollector();
  c.size = IMAGE_CAP - 2;
  assert.equal(c.add({ b64: btoa("abc") }), "over");
  assert.equal(new ImageCollector().add({ done: true, type: "" }), "failed", "no bytes");
});

test("page image: collectImage joins the port's pieces; a port that closes early gives the URL instead", async () => {
  const port = (name: string, script: unknown[]) => {
    const on: ((m: unknown) => void)[] = [];
    const off: (() => void)[] = [];
    const p = { name, onMessage: { addListener: (f: (m: unknown) => void) => on.push(f) }, onDisconnect: { addListener: (f: () => void) => off.push(f) }, disconnect() {} };
    onImagePort(p);
    for (const m of script) for (const f of on) f(m);
    if (!script.length) for (const f of off) f();
  };
  const got = await collectImage(async (name) => port(name, [{ b64: btoa("\x89PNG\r\n\x1a\n") }, { done: true, type: "image/png" }]));
  assert.equal(got!.blob.size, 8);
  assert.equal(F.sniffImage(got!.head), "png");
  assert.equal(await collectImage(async (name) => port(name, [])), null);
  assert.equal(await collectImage(async () => Promise.reject(new Error("no access"))), null);
});

// ---- the decrypt mark ----

test("decrypt plan: only downloaded files; a marked file not in flight closed the process and gets the memory error, never retried by itself", () => {
  const rows = [
    { id: 1, fs: { got: true } },
    { id: 2, fs: { got: true, mark: true } },
    { id: 3, fs: { got: true, mem: true } },
    { id: 4, fs: { plain: true } },
    { id: 5, fs: {} },
    { id: 6, fs: { got: true, mark: true } },
  ];
  assert.deepEqual(F.decryptPlan(rows, new Set([6])), { decrypt: [1], memory: [2] });
  // the Decrypt button skips the memory error and still tries
  assert.deepEqual(F.decryptPlan(rows, new Set([6]), 3), { decrypt: [1, 3], memory: [2] });
});

/** A host whose answers the test sets; decrypt sees the row as stored when it starts. */
class FakeHost implements FileHost {
  reqs: JobReq[] = [];
  answer: (req: JobReq) => Promise<unknown> = async () => null;
  run(req: JobReq): Promise<unknown> {
    this.reqs.push(req);
    return this.answer(req);
  }
}

const FILE: FileValue = { url: "https://b2file.pusharmor.com/v1/x", expires: 0, key: b64urlEncode(new Uint8Array(32).fill(1)), name: "cat.png", size: 1000, sha256: "s".repeat(43) };

async function fileSetup() {
  const clock = new Clock();
  const w = new MockWorker(clock);
  const a = await device(w, clock);
  const b = await device(w, clock, "firefox");
  await pairAndApprove(w, a, b);
  const hostA = new FakeHost();
  const hostB = new FakeHost();
  const storeA = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const storeB = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const told: number[] = [];
  const fa = new Files(a.e, hostA, async () => storeA, () => undefined);
  const fb = new Files(b.e, hostB, async () => storeB, (m) => told.push(m.id));
  fa.quota = fb.quota = async () => null;
  a.e.files = fa;
  b.e.files = fb;
  return { w, clock, a, b, hostA, hostB, storeA, storeB, fa, fb, told };
}

test("send and receive: the file message goes to the device, its row names the file, and a size the picker allows downloads by itself", async () => {
  const s = await fileSetup();
  const expires = Math.floor(s.clock.t / 1000) + 24 * H;
  s.hostA.answer = async (req) => (req.op === "upload" ? { ok: true, url: FILE.url, expires, key: FILE.key, sha256: FILE.sha256 } : null);
  const picked = await s.storeA.putPicked(new Blob([new Uint8Array(1000)]));
  const r = await s.fa.send(picked, "my <cat>.png", 1000, [s.b.id]);
  assert.deepEqual([r.sent, r.total, r.error], [1, 1, undefined]);
  assert.equal(await s.storeA.picked(picked), null, "the picked copy goes once a device got it");
  const out = (await s.a.db.history()).find((x) => x.type === "file")!;
  assert.deepEqual([out.dir, out.content, out.file?.name], ["out", "my _cat_.png", "my _cat_.png"]);
  let ran: (() => void) | null = null;
  const started = new Promise<void>((r) => (ran = r));
  s.hostB.answer = async (req) => {
    ran!();
    return req.op === "download" ? { ok: true, tries: 0 } : null;
  };
  await deliver(s.w, s.b);
  await started;
  const row = (await s.b.db.history()).find((x) => x.type === "file")!;
  assert.deepEqual([row.dir, row.content, row.file?.size, row.file?.expires], ["in", "my _cat_.png", 1000, expires]);
  assert.equal(s.b.p.notes.get("h:" + row.id)?.body, "my _cat_.png", "a file notifies with its name");
  assert.equal(s.hostB.reqs[0]!.op, "download");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await s.b.db.get<HistoryRow>("history", row.id!))!.fs?.got, true);
});

test("receive: a picker that is Off leaves the row waiting for Download; a failed upload says why and sends nothing", async () => {
  const s = await fileSetup();
  await s.b.e.setSettings({ fileAuto: 0 });
  const expires = Math.floor(s.clock.t / 1000) + 24 * H;
  s.hostA.answer = async () => ({ ok: true, url: FILE.url, expires, key: FILE.key, sha256: FILE.sha256 });
  await s.fa.send(await s.storeA.putPicked(new Blob(["x"])), "a.txt", 1, "all");
  await deliver(s.w, s.b);
  assert.equal(s.hostB.reqs.length, 0);
  s.hostA.answer = async () => ({ ok: false, err: { code: "quota", text: "You reached your file limit. Try again in 3 hours", status: 429, error: "file quota" } });
  const r = await s.fa.send(await s.storeA.putPicked(new Blob(["x"])), "a.txt", 1, "all");
  assert.deepEqual([r.sent, r.error], [0, "Unable to send.\nYou reached your file limit. Try again in 3 hours"]);
  assert.equal(sendFileError({ code: "storage", text: null, status: 0, error: "" }, "a.txt"), 'Not enough storage to send "a.txt"');
  assert.equal(sendFileError({ code: "too_large", text: null, status: 413, error: "" }, "a.txt"), '"a.txt" is too large to send');
  assert.equal(sendFileError({ code: "failed", text: null, status: 0, error: "unreadable" }, "a.txt"), 'Unable to read "a.txt"');
});

async function downloadedRow(s: Awaited<ReturnType<typeof fileSetup>>): Promise<number> {
  return s.b.db.addHistory({ dir: "in", peer: s.a.id, type: "file", content: "cat.png", n: 1, pairing_id: null, received: s.clock.t, read: true, file: { ...FILE, expires: Math.floor(s.clock.t / 1000) + H }, fs: { got: true } });
}

test("decrypt: the mark is written before the decrypt starts and cleared after; the file is stored and named an image", async () => {
  const s = await fileSetup();
  const id = await downloadedRow(s);
  s.hostB.answer = async (req) => {
    if (req.op !== "decrypt") return null;
    const r = await s.b.db.get<HistoryRow>("history", id);
    assert.equal(r!.fs!.mark, true, "marked while it runs");
    await s.storeB.putPlain(fileKey(id), new Blob(["png"]));
    return { result: "ok", image: true };
  };
  assert.deepEqual(await s.fb.decryptShown(), []);
  const r = (await s.b.db.get<HistoryRow>("history", id))!;
  assert.deepEqual(r.fs, { got: false, plain: true, image: true, mark: false, mem: false });
  assert.ok((await s.fb.here()).has(fileKey(id)));
});

test("decrypt: out of memory leaves the memory error; a mark found later is the same error and is never tried again; Decrypt tries", async () => {
  const s = await fileSetup();
  const id = await downloadedRow(s);
  s.hostB.answer = async () => ({ result: "memory" });
  assert.deepEqual(await s.fb.decryptShown(), ["cat.png"]);
  assert.deepEqual((await s.b.db.get<HistoryRow>("history", id))!.fs, { got: true, mark: false, mem: true });
  s.hostB.reqs = [];
  assert.deepEqual(await s.fb.decryptShown(), [], "not tried by itself again");
  assert.equal(s.hostB.reqs.length, 0);
  // a mark left by a browser that closed during the decrypt
  const id2 = await downloadedRow(s);
  const r2 = (await s.b.db.get<HistoryRow>("history", id2))!;
  await s.b.db.put("history", { ...r2, fs: { got: true, mark: true } });
  s.hostB.answer = async () => ({ result: "memory" });
  assert.deepEqual(await s.fb.decryptShown(), ["cat.png"]);
  assert.equal(s.hostB.reqs.length, 0, "the marked file is not decrypted again");
  // the Decrypt button tries (and marks)
  s.hostB.answer = async () => ({ result: "memory" });
  assert.deepEqual(await s.fb.decryptShown(id), ["cat.png"]);
  assert.equal(s.hostB.reqs.length, 1);
  assert.equal(F.NO_MEMORY, "Not enough memory to decrypt");
  assert.equal(F.noMemoryToast("cat.png"), 'Not enough memory to decrypt "cat.png"');
  assert.equal(F.saved("cat.png"), 'Saved "cat.png"');
  assert.equal(F.PASTE_IMAGE_CLEAR, "Clear the message to add a file");
});

test("worker: decrypt opens the stored blob, keeps the plaintext, and drops the blob; a damaged blob is said", async () => {
  const store = await FileStore.open(new IDBFactory(), IDBKeyRange);
  const w = new FileWorker({ store, self: async () => null, fetch: async () => new Response(null), progress: () => undefined, save: async () => ({ path: null }), file: { client: "chrome/0", now: () => 0, sleep: async () => undefined, getOffset: async () => 0, setOffset: async () => undefined } });
  const key = new Uint8Array(32).fill(3);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await store.append("f1", await sealFile(key, png));
  assert.deepEqual(await w.decrypt("f1", b64urlEncode(key)), { result: "ok", image: true });
  assert.deepEqual(new Uint8Array(await (await store.plain("f1"))!.arrayBuffer()), png);
  assert.equal(await store.size("f1"), 0);
  await store.append("f2", await sealFile(new Uint8Array(32).fill(4), png));
  assert.deepEqual(await w.decrypt("f2", b64urlEncode(key)), { result: "damaged" });
  assert.deepEqual(await w.decrypt("f9", b64urlEncode(key)), { result: "missing" });
  void sha256Blob;
});

test("storage limit: the oldest decrypted files go first; logout drops every file byte", async () => {
  const s = await fileSetup();
  await s.b.e.setSettings({ fileStorage: 100_000_000 });
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) {
    s.clock.t += 1000;
    const id = await downloadedRow(s);
    ids.push(id);
    await s.storeB.putPlain(fileKey(id), new Blob([new Uint8Array(40_000_000)]));
  }
  await s.fb.evict();
  assert.deepEqual([...(await s.fb.here())].sort(), [fileKey(ids[1]!), fileKey(ids[2]!)].sort());
  await s.b.e.logout();
  assert.equal((await s.storeB.keys()).size, 0);
});

// ---- manifests ----

test("manifest permission diff: Chrome adds only offscreen; no new host permission on Chrome or Firefox; Firefox unchanged", () => {
  const read = (p: string) => JSON.parse(readFileSync(new URL("../../" + p, import.meta.url), "utf8"));
  const chrome = read("chrome/manifest.json");
  const firefox = read("firefox/manifest.json");
  const before = ["notifications", "contextMenus", "storage", "activeTab", "identity", "alarms", "unlimitedStorage", "scripting"];
  assert.deepEqual(chrome.permissions.filter((p: string) => !before.includes(p)), ["offscreen"]);
  assert.deepEqual(before.filter((p) => !chrome.permissions.includes(p)), []);
  assert.deepEqual(chrome.host_permissions, ["https://api.pusharmor.com/*"]);
  assert.equal("optional_host_permissions" in chrome, false);
  assert.deepEqual(firefox.permissions, ["notifications", "menus", "storage", "unlimitedStorage", "activeTab", "alarms", "webRequest", "webRequestBlocking", "https://api.pusharmor.com/*", "https://pusharmor.com/fx/fwd"]);
  assert.deepEqual(firefox.optional_permissions, ["downloads"]);
});

test("decrypt: a host that fails or closes says it could not open the file, with Decrypt; never a memory error", async () => {
  const s = await fileSetup();
  const gone = await downloadedRow(s);
  s.hostB.answer = async () => Promise.reject(new HostGone());
  assert.deepEqual(await s.fb.decryptShown(), []);
  assert.equal((await s.b.db.get<HistoryRow>("history", gone))!.fs!.text, 'Unable to decrypt "cat.png"\nTry again');
  const id = await downloadedRow(s);
  s.hostB.answer = async () => Promise.reject(new Error("no document"));
  assert.deepEqual(await s.fb.decryptShown(), []);
  const fs = (await s.b.db.get<HistoryRow>("history", id))!.fs!;
  assert.deepEqual([fs.mem, fs.code, fs.text], [false, "failed", fileOpenFailed("cat.png")]);
  assert.deepEqual(F.fileRowStatus(fs, false, 0, false, NOW + H, NOW), { k: "undecrypted", text: fileOpenFailed("cat.png") });
  s.hostB.reqs = [];
  assert.deepEqual(await s.fb.decryptShown(), []);
  assert.equal(s.hostB.reqs.length, 0, "a final error is not tried again by itself");
  s.hostB.answer = async () => ({ result: "ok", image: false });
  await s.fb.decryptShown(id);
  assert.equal((await s.b.db.get<HistoryRow>("history", id))!.fs!.code, undefined, "Decrypt clears the error");
});

test("decrypt: not enough storage offers Decrypt, not Download, also after the file expired", () => {
  const fs: F.FileState = { got: true, code: "storage", text: 'Not enough storage to download "a.pdf"' };
  assert.deepEqual(F.fileRowStatus(fs, false, 0, false, NOW + H, NOW), { k: "undecrypted", text: 'Not enough storage to download "a.pdf"' });
  assert.deepEqual(F.fileRowStatus(fs, false, 0, false, NOW - H, NOW).k, "undecrypted");
  assert.deepEqual(F.fileRowStatus({ got: true }, false, 0, false, NOW - H, NOW), { k: "decrypting" }, "downloaded before it expired: it still decrypts");
  assert.deepEqual(F.decryptPlan([{ id: 1, fs }], new Set()), { decrypt: [], memory: [] });
  assert.deepEqual(F.decryptPlan([{ id: 1, fs }], new Set(), 1), { decrypt: [1], memory: [] });
});

test("worker: a second download or decrypt of the same key joins the one running (a restarted service worker)", async () => {
  const store = await FileStore.open(new IDBFactory(), IDBKeyRange);
  let fetches = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const w = new FileWorker({
    store,
    self: async () => null,
    fetch: async () => {
      fetches++;
      await gate;
      return new Response(null, { status: 410 });
    },
    progress: () => undefined,
    save: async () => ({ path: null }),
    file: { client: "chrome/0", now: () => 0, sleep: async () => undefined, getOffset: async () => 0, setOffset: async () => undefined },
  });
  const ref = { url: "https://b2file.pusharmor.com/v1/x", expires: 10, name: "a", size: 5, sha256: "x" };
  const a = w.run({ op: "download", key: "f1", ref, tries: 0, id: 1 });
  const b = w.run({ op: "download", key: "f1", ref, tries: 0, id: 1 });
  assert.equal(w.busy(), true);
  await new Promise((r) => setTimeout(r, 10));
  release();
  assert.deepEqual(await a, await b);
  assert.equal(fetches, 1);
  assert.equal(w.busy(), false);
});

test("send: a failure the popup does not show (it closed) becomes a notification and the picked copy goes; one it shows keeps the copy", async () => {
  const s = await fileSetup();
  s.hostA.answer = async (req) => (req.op === "upload" ? { ok: false, err: { code: "paused", text: "File sending is paused. Try again later", status: 503, error: "files paused" } } : { ok: true });
  const p1 = await s.storeA.putPicked(new Blob(["x"]));
  await s.fa.send(p1, "a.txt", 1, "all");
  const p2 = await s.storeA.putPicked(new Blob(["y"]));
  await s.fa.send(p2, "b.txt", 1, "all");
  s.fa.shown(p2);
  const p3 = await s.storeA.putPicked(new Blob(["z"]));
  await s.fa.send(p3, "c.txt", 1, "all", undefined, true); // a menu send says its own result
  await new Promise((r) => setTimeout(r, 5200));
  assert.equal(s.a.p.noteLog.filter((n) => n.id === "send-result").length, 1, "one notification: the popup showed one, the menu send gives its own");
  assert.equal(s.a.p.notes.get("send-result")?.body, "Unable to send.\nFile sending is paused. Try again later");
  assert.equal(await s.storeA.picked(p1), null);
  assert.ok(await s.storeA.picked(p2));
  assert.equal(sendingCaption("file", ["Phone"], "a.txt"), 'Sending "a.txt" to "Phone"...');
  assert.equal(sendingCaption("file", ["Phone", "Tab"], "a.txt"), 'Sending "a.txt" to:');
  assert.equal(sendFileError({ code: "failed", text: null, status: 0, error: "host" }, "a.txt").split("\n")[0], "Unable to send.");
  // browser start: picked copies left by a closed popup go
  await s.fa.startup();
  assert.equal(await s.storeA.picked(p2), null);
});

test("storage limit counts downloaded blobs too; the file just stored stays; a removed file offers Download again", async () => {
  const s = await fileSetup();
  await s.b.e.setSettings({ fileStorage: 100_000_000 });
  const a = await downloadedRow(s);
  await s.storeB.append(fileKey(a), new Blob([new Uint8Array(60_000_000)]));
  s.clock.t += 1000;
  const b = await downloadedRow(s);
  await s.storeB.putPlain(fileKey(b), new Blob([new Uint8Array(60_000_000)]));
  await s.fb.evict(fileKey(b));
  assert.deepEqual([...(await s.storeB.keys())], [fileKey(b)]);
  const fs = (await s.b.db.get<HistoryRow>("history", a))!.fs!;
  assert.deepEqual(fs, { plain: true });
  assert.equal(F.fileRowStatus(fs, false, 0, false, NOW + H, NOW).k, "failed");
});

test("send: the upload tells the bytes sent, and the Send bar follows them from 0 to 100 percent", async () => {
  const s = await fileSetup();
  const picked = await s.storeA.putPicked(new Blob([new Uint8Array(1000)]));
  // the worker: each piece the upload body sent goes out as progress of the picked key
  const told: [number | string, number, number][] = [];
  const w = new FileWorker({
    store: s.storeA,
    self: async () => (await s.a.e.self()) ?? null,
    fetch: async (_i, _init, sent) => {
      sent?.(0);
      sent?.(500);
      sent?.(1028);
      return new Response(JSON.stringify({ id: "f1", expires: 10 ** 10, url: FILE.url }), { status: 201 });
    },
    progress: (id, have, total) => told.push([id, have, total]),
    save: async () => ({ path: null }),
    file: { client: "chrome/0", now: () => NOW * 1000, sleep: async () => undefined, getOffset: async () => 0, setOffset: async () => undefined },
  });
  const up = await w.upload(picked);
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.deepEqual(told, [[picked, 0, 1028], [picked, 500, 1028], [picked, 1028, 1028]]);
  // the background: progress of the running upload moves the bar; after it ends it is dropped
  const seen: unknown[] = [];
  s.hostA.answer = async (req) => {
    if (req.op !== "upload") return null;
    // encrypting: no count, so the Send popup shows a spinner
    seen.push((await s.a.p.storageSession.get(["busy"])).busy);
    s.fa.progress(picked, 0, 1000);
    await new Promise((r) => setTimeout(r, 5));
    seen.push((await s.a.p.storageSession.get(["busy"])).busy);
    s.fa.progress(picked, 500, 1000);
    await new Promise((r) => setTimeout(r, 5));
    seen.push((await s.a.p.storageSession.get(["busy"])).busy);
    s.fa.progress(picked, 1000, 1000);
    await new Promise((r) => setTimeout(r, 5));
    seen.push((await s.a.p.storageSession.get(["busy"])).busy);
    return { ok: true, url: FILE.url, expires: 10 ** 10, key: FILE.key, sha256: FILE.sha256 };
  };
  await s.fa.send(picked, "a.bin", 1000, [s.b.id]);
  assert.deepEqual(seen.map((b) => [(b as { done: number }).done, (b as { total: number }).total]), [[undefined, undefined], [0, 100], [50, 100], [100, 100]]);
  assert.match((seen[0] as { cap: string }).cap, /^Encrypting for "/);
  for (const b of seen.slice(1)) assert.match((b as { cap: string }).cap, /^Sending to "/);
  s.fa.progress(picked, 1000, 1000);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await s.a.p.storageSession.get(["busy"])).busy, undefined);
});
