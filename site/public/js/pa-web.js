// PushArmor web helpers: b64url, PA-REQ1 request signing, throwaway key, API calls.
// Classic script; defines the global PA. Used by /delete-account and /fx/setup.
(function (g) {
  "use strict";

  var API = "https://api.pusharmor.com";
  var KEY_ITEM = "pa-del-key";
  var enc = new TextEncoder();

  // RFC 4648 URL alphabet, no padding.
  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + raw body bytes
  function reqSigBytes(method, path, time, body) {
    return concat(enc.encode("PA-REQ1\n" + method + "\n" + path + "\n" + time + "\n"), body);
  }

  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  }

  // WebCrypto ECDSA returns raw r||s (64 bytes for P-256).
  async function sign(priv, bytes) {
    var sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, bytes);
    return b64url(new Uint8Array(sig));
  }

  // key = {priv: CryptoKey, pub: b64url of the 65-byte SEC1 point, k: b64url(sha256(pub bytes))}
  async function newKey() {
    var kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    var raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    return { priv: kp.privateKey, pub: b64url(raw), k: b64url(await sha256(raw)) };
  }

  async function saveKey(storage, key) {
    var jwk = await crypto.subtle.exportKey("jwk", key.priv);
    storage.setItem(KEY_ITEM, JSON.stringify({ jwk: jwk, pub: key.pub, k: key.k }));
  }

  // Loads and removes the stored key; null if absent or unusable.
  async function loadKey(storage) {
    var s = storage.getItem(KEY_ITEM);
    storage.removeItem(KEY_ITEM);
    if (!s) return null;
    try {
      var o = JSON.parse(s);
      var priv = await crypto.subtle.importKey("jwk", o.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { priv: priv, pub: o.pub, k: o.k };
    } catch (e) {
      return null;
    }
  }

  // API client. opts: {fetch, sleep, now} (injectable for tests).
  // Retries: up to 3 on 429, 503 and network errors; backoff 0.5, 1.5, 3 s; 8 s budget;
  // Retry-After honored when it fits the budget. Offset re-synced from every PA-Epoch-Ms.
  function Client(opts) {
    opts = opts || {};
    this.fetch = opts.fetch || g.fetch.bind(g);
    this.sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    this.now = opts.now || Date.now;
    this.offset = 0;
  }

  Client.prototype.paTime = function () {
    return String(Math.round(this.now() + this.offset));
  };

  // key: null for unsigned calls, else headers PA-Time + PA-Sig signed by key.
  // unsure: true when an earlier try got no reply or a 503, so it may have taken effect.
  Client.prototype.request = async function (method, path, obj, key) {
    var body = JSON.stringify(obj);
    var bytes = enc.encode(body);
    var delays = [500, 1500, 3000];
    var start = this.now();
    var unsure = false;
    for (var attempt = 0; ; attempt++) {
      var headers = { "Content-Type": "application/json" };
      if (key) {
        var t = this.paTime();
        headers["PA-Time"] = t;
        headers["PA-Sig"] = await sign(key.priv, reqSigBytes(method, path, t, bytes));
      }
      var res = null;
      var data = {};
      try {
        res = await this.fetch(API + path, { method: method, headers: headers, body: body });
      } catch (e) {
        res = null;
      }
      var retryAfter = 0;
      if (res) {
        var epoch = res.headers.get("PA-Epoch-Ms");
        if (epoch && /^[0-9]+$/.test(epoch)) this.offset = Number(epoch) - this.now();
        try { data = await res.json(); } catch (e) { data = {}; }
        if (!data || typeof data !== "object") data = {};
        if (res.status !== 429 && res.status !== 503) return { status: res.status, data: data, unsure: unsure };
        retryAfter = Number(res.headers.get("Retry-After")) || 0;
      }
      if (!res || res.status === 503) unsure = true;
      var result = { status: res ? res.status : 0, data: data, unsure: unsure };
      if (attempt >= 3) return result;
      var wait = Math.max(delays[attempt], retryAfter * 1000);
      if (this.now() - start + wait > 8000) return result;
      await this.sleep(wait);
    }
  };

  // DELETE /v1/account with empty m. On 401 "clock skew" the offset is already re-synced
  // from that reply's PA-Epoch-Ms; re-sign and retry once.
  Client.prototype.deleteAccount = async function (key, ticket) {
    var obj = { ticket: ticket, sign_pub: key.pub, m: {} };
    var r = await this.request("DELETE", "/v1/account", obj, key);
    if (r.status === 401 && r.data.error === "clock skew") {
      r = await this.request("DELETE", "/v1/account", obj, key);
    }
    return r;
  };

  var TEXT = {
    badEmail: "Only email addresses with plain ASCII characters are supported.",
    expired: "Login expired, log in again",
    clock: "This device's clock is off by more than 5 minutes",
    noPeers: "No devices were found under this address",
    deleted: "Your other devices will show \"This device was removed\" and ask for a new login. Pairings are not kept.",
    mailFailed: "Could not send the email, try again",
    network: "Could not reach PushArmor, try again"
  };

  // User text for a failed call.
  function errorText(r) {
    var e = r.data && r.data.error;
    if (r.status === 0) return TEXT.network;
    if (e === "bad email") return TEXT.badEmail;
    if (e === "ticket expired" || e === "invalid ticket") return TEXT.expired;
    if (e === "clock skew") return TEXT.clock;
    if (r.status === 502) return TEXT.mailFailed;
    if (r.status === 429) {
      var s = Number(r.data.retry_after);
      return "Too many tries, wait " + (s > 0 ? s + " s" : "a minute") + " and try again";
    }
    if (e === "wrong code") return "Wrong code, check it and try again";
    if (e === "code expired") return "The code expired, request a new one";
    if (e === "turnstile failed") return "The robot check failed, try again";
    return "Error: " + (typeof e === "string" ? e : "HTTP " + r.status);
  }

  function isAscii(s) {
    return /^[\x00-\x7f]*$/.test(s);
  }

  // /auth/cli helpers. Link fragment: <r|l>.<22 chars of [A-Za-z0-9_-]>.
  var CLI_PURPOSE = { r: "register", l: "login" };

  function parseCliLink(hash) {
    var m = /^#([rl])\.([A-Za-z0-9_-]{22})$/.exec(hash || "");
    return m ? { purpose: CLI_PURPOSE[m[1]], k: m[2] } : null;
  }

  // Result fragment from the OAuth return: #cli_code=<34 chars>&email=<email> or #error=<word>.
  function parseCliResult(hash) {
    var p = new URLSearchParams((hash || "").replace(/^#/, ""));
    var code = p.get("cli_code");
    if (code !== null) return /^[A-Za-z0-9_-]{34}$/.test(code) ? { code: code, email: p.get("email") || "" } : { error: "failed" };
    var err = p.get("error");
    return err !== null ? { error: err } : null;
  }

  function cliEmailBody(email, link, token) {
    return { email: email, cli_k: link.k, purpose: link.purpose, turnstile: token };
  }

  function cliOAuthUrl(provider, link) {
    return API + "/v1/auth/" + provider + "?k=" + encodeURIComponent(link.k) + "&r=cli&p=" + link.purpose;
  }

  g.PA = {
    API: API,
    TEXT: TEXT,
    b64url: b64url,
    reqSigBytes: reqSigBytes,
    sha256: sha256,
    sign: sign,
    newKey: newKey,
    saveKey: saveKey,
    loadKey: loadKey,
    Client: Client,
    errorText: errorText,
    isAscii: isAscii,
    parseCliLink: parseCliLink,
    parseCliResult: parseCliResult,
    cliEmailBody: cliEmailBody,
    cliOAuthUrl: cliOAuthUrl
  };
})(this);
