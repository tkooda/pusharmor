// Checks for the copy and QR code buttons (/js/copyqr.js, /js/qrcode.js).
// Run: node --test site/tools/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { cspDirectives, headersFor, listFiles, parseHeaders, sha256b64, tags, unescapeAttr, urlPath } from "../site-lib.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUB = join(SITE, "public");
const read = (rel) => readFileSync(join(PUB, rel), "utf8");
const htmlFiles = listFiles(PUB).filter((f) => f.endsWith(".html"));
const rules = parseHeaders(read("_headers"));

const HASH = /^[0-9a-f]{64}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//;
// URLs a phone app scans: these, and every link to an APK file (a link inside a sentence gets no icons).
const SCAN_TEXT = ["https://fdroid.pusharmor.com/repo", "fdroidrepos://fdroid.pusharmor.com/repo?fingerprint=262c4f2e9a0220ed48181a5c8650dd742372b220e628fe10e7eea2e9fe6ce4e3", "https://github.com/tkooda/pusharmor"];
const SCAN_HREF = /\.apk$/;

// The element with id="id": tag name, the text the script uses (href for a link, else the
// text), and the index just after it (after the closing </pre> when it sits in a pre).
function target(html, id) {
  const i = html.indexOf(' id="' + id + '"');
  if (i < 0) return null;
  const open = html.lastIndexOf("<", i);
  const name = /^<([a-z]+)/.exec(html.slice(open))[1];
  const startEnd = html.indexOf(">", i) + 1;
  const close = html.indexOf("</" + name + ">", startEnd);
  const inner = html.slice(startEnd, close);
  let end = close + name.length + 3;
  const pre = /^<\/pre>/.exec(html.slice(end));
  if (pre && name === "code") end += pre[0].length;
  const href = tags(html.slice(open, startEnd), name)[0].attrs.href;
  return { name, inner, end, inPre: !!pre, text: name === "a" ? unescapeAttr(href) : unescapeAttr(inner) };
}

function buttons(html) {
  return tags(html, "button").filter((b) => "data-copy" in b.attrs || "data-qr" in b.attrs);
}

function buttonEnd(html, b) {
  return html.indexOf("</button>", b.index) + "</button>".length;
}

test("every copy button sits right after its text, copies that text, and is named for its kind", () => {
  let n = 0;
  for (const rel of htmlFiles) {
    const html = read(rel);
    for (const b of buttons(html).filter((x) => "data-copy" in x.attrs)) {
      n++;
      const id = b.attrs["data-copy"];
      const t = target(html, id);
      assert.ok(t, rel + ": no element " + id);
      assert.equal(html.slice(t.end, b.index).trim(), "", rel + ": copy button is not right after " + id);
      assert.equal(b.attrs.type, "button", rel + ": " + id);
      assert.ok("hidden" in b.attrs, rel + ": " + id + " button must be hidden until the script runs");
      if (t.name === "code") assert.doesNotMatch(t.inner, /[<>]/, rel + ": " + id + " holds markup");
      else assert.equal(t.name, "a", rel + ": " + id);
      const kind = HASH.test(t.text) ? "SHA-256" : URL_RE.test(t.text) ? "URL" : "command";
      if (kind === "command") assert.ok(t.inPre, rel + ": command " + id + " is not in a pre block");
      assert.equal(b.attrs["aria-label"], "Copy " + kind, rel + ": " + id);
    }
  }
  assert.ok(n >= 11, "copy buttons: " + n);
});

test("every code element has a copy button and no link has one", () => {
  for (const rel of htmlFiles) {
    const html = read(rel);
    const copied = new Set(buttons(html).map((b) => b.attrs["data-copy"]).filter(Boolean));
    for (const c of tags(html, "code")) assert.ok(copied.has(c.attrs.id), rel + ": no copy button for " + c.raw);
    for (const a of tags(html, "a")) assert.ok(!copied.has(a.attrs.id), rel + ": a link has a copy button: " + a.attrs.href);
  }
});

test("QR buttons: exactly the phone-scannable URLs, right after their copy button or link, never a hash", () => {
  let n = 0;
  for (const rel of htmlFiles) {
    const html = read(rel);
    const bs = buttons(html);
    const want = new Set();
    for (const a of tags(html, "a")) if (SCAN_HREF.test(unescapeAttr(a.attrs.href || ""))) want.add(a.attrs.id);
    for (const c of tags(html, "code")) if (c.attrs.id && SCAN_TEXT.includes(target(html, c.attrs.id).text)) want.add(c.attrs.id);
    const got = new Set();
    for (const b of bs.filter((x) => "data-qr" in x.attrs)) {
      n++;
      const id = b.attrs["data-qr"];
      const t = target(html, id);
      assert.ok(t, rel + ": no element " + id);
      assert.doesNotMatch(t.text, HASH, rel + ": QR button for a hash " + id);
      const copy = bs.find((x) => x.attrs["data-copy"] === id);
      const from = copy ? buttonEnd(html, copy) : t.end;
      assert.equal(html.slice(from, b.index).trim(), "", rel + ": QR button is not right after " + (copy ? "the copy button for " : "") + id);
      assert.match(b.attrs["aria-label"], /^Show QR code for \S/, rel + ": " + id);
      assert.equal(b.attrs.type, "button", rel + ": " + id);
      assert.ok("hidden" in b.attrs, rel + ": " + id);
      got.add(id);
    }
    assert.deepEqual([...got].sort(), [...want].sort(), rel + ": QR button set");
  }
  assert.equal(n, 5, "QR buttons");
});

const ctx = {};
vm.createContext(ctx);
vm.runInContext(read("js/qrcode.js"), ctx, { filename: "qrcode.js" });
vm.runInContext(read("js/copyqr.js"), ctx, { filename: "copyqr.js" });
const PACQ = ctx.PACQ;
const bits = (m) => Array.from(m, (r) => Array.from(r, (d) => (d ? "1" : "0")).join(""));

test("QR code for the F-Droid repository URL equals the reference from a second encoder", () => {
  const ref = readFileSync(join(SITE, "tools", "test", "fixtures", "qr-fdroid-repo.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(bits(PACQ.matrix("https://fdroid.pusharmor.com/repo")), ref);
});

test("QR code text is the link href or the code text; each scannable URL encodes", () => {
  assert.equal(PACQ.targetText({ tagName: "A", getAttribute: (k) => (k === "href" ? "fdroidrepos://x?y=1" : null), textContent: "Add" }), "fdroidrepos://x?y=1");
  assert.equal(PACQ.targetText({ tagName: "CODE", textContent: "https://fdroid.pusharmor.com/repo" }), "https://fdroid.pusharmor.com/repo");
  const html = read("download.html");
  for (const b of buttons(html).filter((x) => "data-qr" in x.attrs)) {
    const m = PACQ.matrix(target(html, b.attrs["data-qr"]).text);
    assert.ok(m.length >= 21 && (m.length - 21) % 4 === 0, b.attrs["data-qr"]);
  }
  assert.notDeepEqual(bits(PACQ.matrix("https://fdroid.pusharmor.com/repo")), bits(PACQ.matrix("https://fdroid.pusharmor.com/repO")));
});

test("pages with the buttons load qrcode.js then copyqr.js, deferred, and their CSP allows both", () => {
  const h = (rel) => "'sha256-" + sha256b64(readFileSync(join(PUB, rel))) + "'";
  for (const rel of htmlFiles) {
    const html = read(rel);
    const srcs = tags(html, "script").map((s) => s.attrs.src);
    if (!buttons(html).length) {
      assert.ok(!srcs.includes("/js/copyqr.js"), rel);
      continue;
    }
    assert.deepEqual(srcs.filter((s) => s === "/js/qrcode.js" || s === "/js/copyqr.js"), ["/js/qrcode.js", "/js/copyqr.js"], rel);
    for (const s of tags(html, "script")) assert.ok("defer" in s.attrs, rel + ": " + s.attrs.src);
    const d = cspDirectives(headersFor(rules, urlPath(rel))["content-security-policy"][0]);
    for (const need of ["'self'", h("js/qrcode.js"), h("js/copyqr.js")]) assert.ok(d["script-src"].includes(need), rel + ": CSP lacks " + need);
  }
});

test("the old F-Droid QR image and its toggle are gone", () => {
  assert.ok(!listFiles(PUB).includes("img/fdroid-qr.png"));
  assert.doesNotMatch(read("download.html"), /fdroid-qr|<details/);
});

// The element that holds a button: walk the tags before it and keep a stack of open elements.
function parentOf(html, index) {
  const VOID = new Set(["meta", "link", "br", "img", "input", "hr", "path", "rect", "circle", "line", "polyline"]);
  const stack = [];
  const re = /<(\/?)([a-z][a-z0-9]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(html.slice(0, index)))) {
    const [, close, name, rest] = m;
    if (close) {
      const k = stack.map((e) => e.name).lastIndexOf(name);
      if (k >= 0) stack.length = k;
    } else if (!VOID.has(name) && !rest.endsWith("/")) {
      stack.push({ name, cls: (/class="([^"]*)"/.exec(rest) || [])[1] || "" });
    }
  }
  return stack[stack.length - 1];
}

test("icons sit only at the end of a data line: a copy-row box or a table cell, never in a paragraph", () => {
  let n = 0;
  for (const rel of htmlFiles) {
    const html = read(rel);
    for (const b of buttons(html)) {
      n++;
      const p = parentOf(html, b.index);
      const ok = p && ((p.name === "div" && p.cls.split(" ").includes("copy-row")) || p.name === "td");
      assert.ok(ok, rel + ": icon button " + (b.attrs["data-copy"] || b.attrs["data-qr"]) + " is inside <" + (p && p.name) + ">");
    }
  }
  assert.ok(n >= 15, "buttons: " + n);
});

test("the F-Droid add URL line copies and shows a QR of the exact add URL, icons outside any p", () => {
  const html = read("download.html");
  const want = "fdroidrepos://fdroid.pusharmor.com/repo?fingerprint=262c4f2e9a0220ed48181a5c8650dd742372b220e628fe10e7eea2e9fe6ce4e3";
  const t = target(html, "fdroid-add-url");
  assert.equal(t.text, want);
  assert.ok(html.includes('data-copy="fdroid-add-url"') && html.includes('data-qr="fdroid-add-url"'));
  assert.ok(html.indexOf('data-copy="fdroid-add-url"') < html.indexOf('data-qr="fdroid-add-url"'));
  const row = html.slice(html.lastIndexOf('<div class="copy-row">', html.indexOf('id="fdroid-add-url"')));
  assert.doesNotMatch(row.slice(0, row.indexOf("</div>")), /<p[ >]/);
});
