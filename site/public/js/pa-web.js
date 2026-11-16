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

  // API client. opts: {fetch, sleep, now} (injectable for tests); client: the PA-Client value,
  // "delete-account" or "cli-login" for those two pages (never held to a version floor).
  // Retries: up to 3 on 429, 503 and network errors; backoff 0.5, 1.5, 3 s; 8 s budget;
  // Retry-After honored when it fits the budget. Offset re-synced from every PA-Epoch (seconds).
  function Client(opts) {
    opts = opts || {};
    this.fetch = opts.fetch || g.fetch.bind(g);
    this.sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    this.now = opts.now || Date.now;
    this.client = opts.client;
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
      var headers = { "Content-Type": "application/json", "PA-Client": this.client };
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
        var epoch = res.headers.get("PA-Epoch");
        if (epoch && /^[0-9]+$/.test(epoch)) this.offset = Number(epoch) * 1000 - this.now();
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
  // from that reply's PA-Epoch; re-sign and retry once.
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
    network: "Could not reach PushArmor, try again",
    update: "Update PushArmor to continue."
  };

  var ACTION = {
    sendCode: "Unable to send the code.",
    checkCode: "Unable to check the code.",
    deleteAccount: "Unable to delete the account."
  };

  function wait(s) {
    var m = Math.ceil(s / 60);
    return s > 60 ? m + (m === 1 ? " minute" : " minutes") : s + (s === 1 ? " second" : " seconds");
  }

  // Why a call failed: the same reason lines as the browser extension.
  function reasonText(r) {
    var e = r.data && r.data.error;
    var s = r.status;
    if (s === 0) return "The relay server could not be reached. Check your internet connection and try again.";
    if (s === 426) return "This version of PushArmor is too old. Update PushArmor to continue.";
    if (s === 429) return "Too many tries. Try again in " + wait(Number(r.data && r.data.retry_after) > 0 ? Number(r.data.retry_after) : 60) + ".";
    if (s === 401 && typeof e === "string" && e.indexOf("clock skew") === 0) return "This device's clock is off by more than 5 minutes. Fix the clock and try again.";
    if (s === 401 && e === "ticket expired") return "The login expired. Log in again.";
    if (s === 401 && (e === "invalid ticket" || e === "bad ticket")) return "The login link is not valid. Request a new code and try again.";
    if (s === 401 && e === "wrong code") return "The code is not correct. Check the newest email from PushArmor and try again.";
    if (s === 401 && e === "code expired") return "The code expired. Request a new code to continue.";
    if (s === 403 && e === "banned") return "This account is blocked.";
    if (s === 403 && e === "turnstile failed") return "The security check did not finish. Try again.";
    if (s === 400 && e === "bad email") return TEXT.badEmail;
    if ((s === 400 && e === "bad request") || s === 404 || s === 405 || (s === 401 && (e === "invalid client signature" || e === "bad id"))) return "The relay server did not accept the request. Update PushArmor and try again.";
    if (s === 502 && e === "email send failed") return "The relay server could not send the email. Try again.";
    if (s >= 500 && s <= 599) return "The relay server is not working right now. Try again later.";
    return "Try again.";
  }

  // User text for a failed call: line 1 says what could not be done, line 2 says why.
  function errorText(action, r) {
    return ACTION[action] + "\n" + reasonText(r);
  }

  function isAscii(s) {
    return /^[\x00-\x7f]*$/.test(s);
  }

  // /auth/cli helpers. Link fragment: <r|l><22 chars of [A-Za-z0-9_-]>.
  var CLI_PURPOSE = { r: "register", l: "login" };

  function parseCliLink(hash) {
    var m = /^#([rl])([A-Za-z0-9_-]{22})$/.exec(hash || "");
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
