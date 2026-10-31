// Real-browser popup size and layout check (I458, I475), run by webext.yml:
//   node build.mjs --dev --shots && node popup-check.mjs
// Firefox: headless Firefox driven by geckodriver opens the real toolbar popup (popup.html,
// logged out) on cold starts and fails unless the popup is 400x560 from the first sample.
// It then opens a copy whose popup is shots.html (canned replies, all four tabs), clicks
// every tab, and fails if the popup size or the header, tab bar, or content area moves.
// Chromium (branded Chrome ignores --load-extension, so pages load over http): popup.html
// must be 400x560, and the same tab cycle in shots.html must keep every rect and have no
// layout shift. Env: FIREFOX, GECKODRIVER, CHROME (binaries); POPUP_OPENS (cold opens, 3).
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";

const W = 400;
const H = 560;
const here = new URL(".", import.meta.url).pathname;
const ffDist = resolve(here, "../firefox/dist/unpacked");
const crDist = resolve(here, "../chrome/dist/unpacked");
if (!existsSync(join(crDist, "shots.html")) || !existsSync(ffDist)) {
  console.error("run node build.mjs --dev --shots first");
  process.exit(1);
}
const OPENS = Number(process.env.POPUP_OPENS ?? 3);
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log("FAIL " + msg);
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Runs in the page: clicks every tab and reports any rect that differs from the first.
const CYCLE = `(async () => {
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const R = (e) => { if (!e) return "none"; const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map(Math.round).join(","); };
  let cls = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}
  for (let i = 0; i < 200 && !document.querySelector("[data-tab]"); i++) await sleep(25);
  const snap = () => JSON.stringify({ w: innerWidth, h: innerHeight, top: R(document.querySelector(".top")), panel: R(document.getElementById("panel")), sw: document.documentElement.scrollWidth });
  await sleep(300);
  const base = snap();
  const bad = [];
  for (let c = 0; c < 2; c++) for (const t of ["history", "peers", "settings", "send"]) {
    document.querySelector('[data-tab="' + t + '"]').click();
    for (let k = 0; k < 20; k++) { const s = snap(); if (s !== base) bad.push(t + " " + s); await sleep(16); }
  }
  const out = JSON.stringify({ base, bad: bad.slice(0, 4), cls: Math.round(cls * 1000) / 1000 });
  document.title = "POPCHECK " + out;
  const pre = document.createElement("pre"); pre.id = "popcheck"; pre.hidden = true; pre.textContent = out; document.body.append(pre);
})();`;

// ------------------------------------------------------------------ Firefox

async function firefoxCheck() {
  const gd = process.env.GECKODRIVER ?? (process.env.GECKOWEBDRIVER ? join(process.env.GECKOWEBDRIVER, "geckodriver") : "geckodriver");
  const ffBin = process.env.FIREFOX ?? "firefox";
  const tmp = mkdtempSync(join(tmpdir(), "pa-popcheck-"));
  try {
    // the shots copy: popup is shots.html (all tabs, canned replies) plus the cycle script
    const shotsExt = join(tmp, "shots-ext");
    cpSync(ffDist, shotsExt, { recursive: true });
    for (const f of ["shots.html", "shots.js"]) cpSync(join(crDist, f), join(shotsExt, f));
    writeFileSync(join(shotsExt, "popcheck.js"), CYCLE);
    const sh = join(shotsExt, "shots.html");
    writeFileSync(sh, readFileSync(sh, "utf8").replace("</body>", '<script src="popcheck.js"></script></body>'));
    const mf = JSON.parse(readFileSync(join(shotsExt, "manifest.json"), "utf8"));
    (mf.browser_action ?? mf.action).default_popup = "shots.html?platform=firefox&bare";
    writeFileSync(join(shotsExt, "manifest.json"), JSON.stringify(mf));
    const id = mf.browser_specific_settings.gecko.id;
    const widget = id.toLowerCase().replace(/[^a-z0-9_-]/g, "_") + "-browser-action";

    for (let i = 0; i < OPENS; i++) {
      await withFirefox(gd, ffBin, tmp, ffDist, async (wd) => {
        const s = await openPopup(wd, widget);
        console.log("firefox cold open " + (i + 1) + ": " + s.join(" "));
        if (!s.length || s.some((x) => x !== W + "x" + H)) fail("firefox cold open " + (i + 1) + ": popup sizes " + (s.join(" ") || "none") + ", want " + W + "x" + H);
      });
    }
    await withFirefox(gd, ffBin, tmp, shotsExt, async (wd) => {
      const s = await openPopup(wd, widget, 4000);
      const title = await wd.exec("const p=[...document.querySelectorAll('panel')].find(p=>p.state==='open');return p&&p.querySelector('browser')?.contentTitle||''");
      console.log("firefox tab cycle: sizes " + s.join(" ") + "; " + title);
      if (new Set(s).size !== 1 || s[0] !== W + "x" + H) fail("firefox tab cycle: popup sizes " + s.join(" "));
      if (!title.startsWith("POPCHECK ")) fail("firefox tab cycle: no result (" + title + ")");
      else {
        const r = JSON.parse(title.slice(9));
        if (r.bad.length) fail("firefox tab cycle: moved from " + r.base + ": " + r.bad.join("; "));
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function withFirefox(gd, bin, tmp, ext, fn) {
  const port = 4444 + Math.floor(Math.random() * 1000);
  // geckodriver 0.36+ needs --allow-system-access for the chrome context; older ones reject it
  const help = await promisify(execFile)(gd, ["--help"]).then((r) => r.stdout, () => "");
  const proc = spawn(gd, ["--port", String(port), ...(help.includes("allow-system-access") ? ["--allow-system-access"] : [])], { stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (j.value && j.value.error) throw new Error(path + ": " + j.value.error + ": " + j.value.message);
    return j.value;
  };
  for (let i = 0; ; i++) {
    try {
      await call("GET", "/status");
      break;
    } catch (e) {
      if (i > 100) throw new Error("geckodriver did not start: " + e.message);
      await sleep(100);
    }
  }
  let sid = null;
  try {
    const prefs = {
      "xpinstall.signatures.required": false, "extensions.autoDisableScopes": 0,
      "browser.shell.checkDefaultBrowser": false, "datareporting.policy.dataSubmissionEnabled": false,
      "toolkit.telemetry.reportingpolicy.firstRun": false, "browser.aboutwelcome.enabled": false,
    };
    const ses = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { binary: bin, args: ["-headless", "-profile", mkdtempSync(join(tmp, "prof-"))], prefs } } } });
    sid = ses.sessionId;
    await call("POST", `/session/${sid}/window/rect`, { width: 1200, height: 900 });
    await call("POST", `/session/${sid}/moz/addon/install`, { path: ext, temporary: true });
    await call("POST", `/session/${sid}/moz/context`, { context: "chrome" });
    const wd = { exec: (script, args = []) => call("POST", `/session/${sid}/execute/sync`, { script, args }) };
    await fn(wd);
  } finally {
    if (sid) await call("DELETE", `/session/${sid}`).catch(() => undefined);
    proc.kill();
  }
}

/** Pins the toolbar button, clicks it, and samples the popup size for ms. */
async function openPopup(wd, widget, ms = 1500) {
  await wd.exec(`
    let m;
    try { m = ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs"); }
    catch { m = ChromeUtils.importESModule("resource:///modules/CustomizableUI.sys.mjs"); }
    m.CustomizableUI.addWidgetToArea(arguments[0], m.CustomizableUI.AREA_NAVBAR);`, [widget]);
  await sleep(1000);
  const sizes = [];
  for (let tries = 0; tries < 3 && !sizes.length; tries++) {
    await wd.exec("document.getElementById(arguments[0]).querySelector('toolbarbutton').click()", [widget]);
    const t = Date.now();
    while (Date.now() - t < ms) {
      const s = await wd.exec(`const p=[...document.querySelectorAll('panel')].find(p=>p.state==='open');
        const b=p&&p.querySelector('browser'); if(!b) return null; const r=b.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height);`);
      if (s) sizes.push(s);
      await sleep(50);
    }
  }
  return [...new Set(sizes)];
}

// ------------------------------------------------------------------ Chromium

async function chromiumCheck() {
  const bin = process.env.CHROME ?? "google-chrome";
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    if (path === "/popcheck.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(CYCLE);
    const file = resolve(join(crDist, path));
    if (!file.startsWith(crDist + "/") || !existsSync(file)) return res.writeHead(404).end();
    let body = readFileSync(file);
    if (path === "/shots.html") body = body.toString().replace("</body>", '<script src="popcheck.js"></script></body>');
    // popup.html as a plain page: its size comes from static CSS only (no extension API here)
    if (path === "/popup.html") body = body.toString().replace("</body>", "<script>addEventListener('load',()=>{const b=document.body.getBoundingClientRect();const p=document.createElement('pre');p.id='popcheck';p.textContent=JSON.stringify({size:Math.round(b.width)+'x'+Math.round(b.height)});document.documentElement.append(p)})</script></body>");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  const run = promisify(execFile);
  const dump = async (page) => {
    const profile = mkdtempSync(join(tmpdir(), "pa-popcheck-cr-"));
    try {
      const { stdout } = await run(bin, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars",
        "--window-size=" + W + "," + H, "--virtual-time-budget=6000", "--user-data-dir=" + profile, "--dump-dom", `http://127.0.0.1:${port}/${page}`], { timeout: 60_000, maxBuffer: 1 << 24 });
      const m = /<pre id="popcheck"[^>]*>([^<]*)<\/pre>/.exec(stdout);
      return m ? JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) : null;
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  };
  try {
    const p = await dump("popup.html");
    console.log("chromium popup.html: " + JSON.stringify(p));
    if (!p || p.size !== W + "x" + H) fail("chromium popup.html body " + (p?.size ?? "no result") + ", want " + W + "x" + H);
    const c = await dump("shots.html?bare#send");
    console.log("chromium tab cycle: " + JSON.stringify(c));
    if (!c) fail("chromium tab cycle: no result");
    else {
      if (c.bad.length) fail("chromium tab cycle: moved from " + c.base + ": " + c.bad.join("; "));
      if (c.cls > 0) fail("chromium tab cycle: layout shift " + c.cls);
      if (!c.base.includes('"panel":"0,92,400,468"')) fail("chromium: content area " + c.base + ", want 0,92,400,468");
    }
  } finally {
    server.close();
  }
}

const only = process.argv[2];
if (only !== "chromium") await firefoxCheck().catch((e) => fail("firefox: " + e.message));
if (only !== "firefox") await chromiumCheck().catch((e) => fail("chromium: " + e.message));
console.log(failures.length ? failures.length + " popup check(s) failed" : "popup checks passed");
process.exit(failures.length ? 1 : 0);
