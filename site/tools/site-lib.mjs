// Shared helpers for the site hash script and the site checks. Node built-ins only.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function sha256b64(data) {
  return createHash("sha256").update(data).digest("base64");
}

// All files under dir (relative paths with "/"), sorted.
export function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  })(dir);
  return out.sort();
}

// URL path served for a file in the assets dir (html_handling auto-trailing-slash).
export function urlPath(rel) {
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return "/" + rel.slice(0, -"index.html".length);
  if (rel.endsWith(".html")) return "/" + rel.slice(0, -".html".length);
  return "/" + rel;
}

// Resolves a site-absolute URL path to an asset file, or null.
export function resolvePath(files, path) {
  const p = path.replace(/[?#].*$/, "");
  const set = new Set(files);
  const rel = p.replace(/^\//, "");
  const cands = [rel, rel + ".html", rel.replace(/\/$/, "") + "/index.html"];
  if (p === "/") cands.unshift("index.html");
  for (const c of cands) if (set.has(c)) return c;
  return null;
}

// Tags with their attributes. Pages are hand-written with one tag per line segment.
export function tags(html, name) {
  const re = new RegExp("<" + name + "\\b([^>]*)>", "gi");
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], attrs: attrs(m[1]), index: m.index });
  return out;
}

export function attrs(s) {
  const a = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) a[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  return a;
}

export function unescapeAttr(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// Inline scripts (no src): their exact text.
export function inlineScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) if (!("src" in attrs(m[1]))) out.push(m[2]);
  return out;
}

// _headers: [{path, lines: [{remove: name} | {name, value}]}]
export function parseHeaders(text) {
  const rules = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), lines: [] });
      continue;
    }
    if (!rules.length) throw new Error("_headers: header line before a path: " + line);
    const t = line.trim();
    if (t.startsWith("!")) {
      rules[rules.length - 1].lines.push({ remove: t.slice(1).trim().toLowerCase() });
    } else {
      const i = t.indexOf(":");
      if (i <= 0) throw new Error("_headers: bad line: " + line);
      rules[rules.length - 1].lines.push({ name: t.slice(0, i).trim().toLowerCase(), value: t.slice(i + 1).trim() });
    }
  }
  return rules;
}

export function patternMatches(pattern, path) {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(path);
}

// Headers a path gets from _headers rules, in order: {name: [values]}.
export function headersFor(rules, path) {
  const h = {};
  for (const r of rules) {
    if (!patternMatches(r.path, path)) continue;
    for (const l of r.lines) {
      if (l.remove) delete h[l.remove];
      else (h[l.name] ||= []).push(l.value);
    }
  }
  return h;
}

export function cspDirectives(csp) {
  const d = {};
  for (const part of csp.split(";")) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length) d[toks[0].toLowerCase()] = toks.slice(1);
  }
  return d;
}

// Script hashes ('sha256-...') a rule must allow: every script of every matched page, inline
// and file, plus each matched .js file and the files it loads with importScripts.
export function scriptHashesForRule(pub, files, pattern) {
  const hashes = [];
  const add = (h) => { if (!hashes.includes(h)) hashes.push(h); };
  const fileHash = (rel) => "'sha256-" + sha256b64(readFileSync(join(pub, rel))) + "'";
  for (const rel of files) {
    if (!patternMatches(pattern, urlPath(rel))) continue;
    if (rel.endsWith(".html")) {
      const html = readFileSync(join(pub, rel), "utf8");
      for (const t of tags(html, "script")) {
        const src = t.attrs.src;
        if (src === undefined || !src.startsWith("/")) continue;
        const f = resolvePath(files, src);
        if (!f) throw new Error(rel + ": missing script " + src);
        add(fileHash(f));
      }
      for (const s of inlineScripts(html)) add("'sha256-" + sha256b64(s) + "'");
    } else if (rel.endsWith(".js")) {
      add(fileHash(rel));
      const js = readFileSync(join(pub, rel), "utf8");
      for (const m of js.matchAll(/importScripts\(\s*"([^"]+)"\s*\)/g)) {
        const f = resolvePath(files, m[1]);
        if (!f) throw new Error(rel + ": missing import " + m[1]);
        add(fileHash(f));
      }
    }
  }
  return hashes;
}

// Returns {rel: newContent} for every file whose SRI or CSP hashes are not current.
export function computeHashUpdates(pub) {
  const files = listFiles(pub);
  const updates = {};
  for (const rel of files.filter((f) => f.endsWith(".html"))) {
    const html = readFileSync(join(pub, rel), "utf8");
    const next = html.replace(/<(script|link)\b([^>]*)>/gi, (whole, name, a) => {
      const at = attrs(a);
      const ref = name.toLowerCase() === "script" ? at.src : at.href;
      if (ref === undefined || !ref.startsWith("/")) return whole;
      const f = resolvePath(files, ref);
      if (!f) throw new Error(rel + ": missing " + ref);
      const integ = "sha256-" + sha256b64(readFileSync(join(pub, f)));
      if ("integrity" in at) return whole.replace(/integrity="[^"]*"/, 'integrity="' + integ + '"');
      return whole.replace(/\s*>$/, ' integrity="' + integ + '">');
    });
    if (next !== html) updates[rel] = next;
  }
  const htext = readFileSync(join(pub, "_headers"), "utf8");
  let path = null;
  const out = htext.split("\n").map((line) => {
    if (line.trim() && !/^\s/.test(line)) path = line.trim();
    const m = /^(\s+Content-Security-Policy:\s*)(.*)$/i.exec(line);
    if (!m || !/(^|;)\s*script-src\b/.test(m[2])) return line;
    const hashes = scriptHashesForRule(pub, files, path);
    const parts = m[2].split(";").map((part) => {
      const toks = part.trim().split(/\s+/).filter(Boolean);
      if (toks[0] !== "script-src") return part.trim();
      const rest = toks.slice(1).filter((t) => !t.startsWith("'sha256-"));
      const self = rest.filter((t) => t === "'self'");
      const other = rest.filter((t) => t !== "'self'");
      return ["script-src", ...self, ...hashes, ...other].join(" ");
    });
    return m[1] + parts.join("; ");
  }).join("\n");
  if (out !== htext) updates["_headers"] = out;
  return updates;
}

// site/wrangler.jsonc may hold exactly these keys (component-website-r1 section 2).
export function checkWranglerConfig(cfg, siteName) {
  const errs = [];
  const allowed = ["name", "build", "compatibility_date", "assets", "workers_dev", "preview_urls", "routes"];
  for (const k of Object.keys(cfg)) if (!allowed.includes(k)) errs.push("key not allowed: " + k);
  for (const k of allowed) if (!(k in cfg)) errs.push("key missing: " + k);
  if (cfg.name !== siteName) errs.push("name must be " + siteName);
  if (typeof cfg.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.compatibility_date)) errs.push("bad compatibility_date");
  const a = cfg.assets || {};
  const wantAssets = { directory: "./dist", not_found_handling: "404-page", html_handling: "auto-trailing-slash" };
  if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(Object.keys(wantAssets).sort())) errs.push("assets keys must be directory, not_found_handling, html_handling");
  for (const [k, v] of Object.entries(wantAssets)) if (a[k] !== v) errs.push("assets." + k + " must be " + v);
  if (JSON.stringify(cfg.build) !== JSON.stringify({ command: "node tools/build.mjs" })) errs.push("build must be exactly the command node tools/build.mjs");
  if (cfg.workers_dev !== false) errs.push("workers_dev must be false");
  if (cfg.preview_urls !== false) errs.push("preview_urls must be false");
  if (JSON.stringify(cfg.routes) !== JSON.stringify([{ pattern: "pusharmor.com", custom_domain: true }])) errs.push("routes must be exactly the pusharmor.com custom domain");
  return errs;
}

// JSONC: strips // and /* */ comments outside strings, then JSON.parse.
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out);
}

// Loaded resources with an external host (script, link, img, iframe, frame, source, audio,
// video, embed, object, track). Plain <a href> links are not loads and are ignored.
export function externalLoads(html) {
  const out = [];
  const spec = { script: ["src"], link: ["href"], img: ["src", "srcset"], iframe: ["src"], frame: ["src"], source: ["src", "srcset"], audio: ["src"], video: ["src", "poster"], embed: ["src"], object: ["data"], track: ["src"] };
  for (const [name, keys] of Object.entries(spec)) {
    for (const t of tags(html, name)) {
      for (const k of keys) {
        const v = t.attrs[k];
        if (v !== undefined && /^(https?:)?\/\/|^[a-z][a-z0-9+.-]*:/i.test(v.trim())) out.push(unescapeAttr(v.trim()));
      }
    }
  }
  return out;
}

// Visible text: tags removed, entities decoded, whitespace collapsed.
export function pageText(html) {
  return unescapeAttr(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// Names every html/js/json/txt/_headers file under dir that holds an uppercase release placeholder.
export function placeholderFiles(dir) {
  const bad = [];
  for (const f of listFiles(dir)) {
    if (!/\.(html|js|json|txt)$/.test(f) && f !== "_headers") continue;
    const body = readFileSync(join(dir, f), "utf8");
    for (const w of ["PLACEHOLDER", "CHROME_EXTENSION_ID", "CHROME_BETA_EXTENSION_ID"]) {
      if (body.includes(w)) bad.push("site/public/" + f + ": " + w);
    }
  }
  return bad;
}
