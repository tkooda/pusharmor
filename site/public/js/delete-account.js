// /delete-account: prove the account with a throwaway key (email code or OAuth, purpose
// "delete-account"), then DELETE /v1/account with empty m. Needs /js/pa-web.js.
(function () {
  "use strict";

  var SITE = "https://pusharmor.com";
  var PURPOSE = "delete-account";
  var PA = window.PA;
  var client = new PA.Client();
  var key = null;
  var tsToken = null;
  var requestToken = null;
  var ticket = null;

  function $(id) { return document.getElementById(id); }
  var status = $("status");
  var ts = $("ts");

  function say(text) { status.textContent = text; }

  function show(step) {
    $("prove").hidden = step !== "prove" && step !== "code";
    $("code-form").hidden = step !== "code";
    $("confirm").hidden = step !== "confirm";
    $("done").hidden = step !== "done";
  }

  async function restart(text) {
    key = await PA.newKey();
    client.offset = 0;
    requestToken = null;
    ticket = null;
    show("prove");
    say(text || "");
  }

  function freshTurnstile() {
    tsToken = null;
    try { ts.contentWindow.location.reload(); } catch (e) { /* same origin; ignore */ }
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== SITE || e.source !== ts.contentWindow) return;
    var d = e.data;
    if (d && d.pa === "turnstile" && typeof d.token === "string") tsToken = d.token;
    // The widget posts its height (an interactive challenge is taller); fit the frame to it.
    if (d && d.pa === "turnstile-size" && typeof d.h === "number") ts.style.height = Math.min(600, Math.max(65, Math.ceil(d.h))) + "px";
  });

  $("email-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("email").value.trim();
    if (!PA.isAscii(email)) { say(PA.TEXT.badEmail); return; }
    if (!tsToken) { say("Wait for the robot check above to finish, then try again"); return; }
    var token = tsToken;
    freshTurnstile();
    say("Sending code...");
    var r = await client.request("POST", "/v1/auth/email",
      { email: email, sign_pub: key.pub, purpose: PURPOSE, turnstile: token }, null);
    if (r.status === 200 && typeof r.data.request_token === "string") {
      requestToken = r.data.request_token;
      show("code");
      say("Code sent. Enter the 6-character code from the email.");
      $("code").focus();
    } else {
      say(PA.errorText(r));
    }
  });

  $("code-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var code = $("code").value.replace(/[\s-]/g, "").toUpperCase();
    say("Checking code...");
    var r = await client.request("POST", "/v1/auth/email/verify",
      { request_token: requestToken, code: code }, null);
    if (r.status === 200 && typeof r.data.ticket === "string") {
      signedIn(r.data.ticket, r.data.email);
    } else {
      say(PA.errorText(r));
    }
  });

  function oauth(provider) {
    return async function () {
      await PA.saveKey(sessionStorage, key);
      location.assign(PA.API + "/v1/auth/" + provider + "?k=" + encodeURIComponent(key.k) +
        "&r=web&p=" + PURPOSE);
    };
  }
  $("google").addEventListener("click", oauth("google"));
  $("apple").addEventListener("click", oauth("apple"));

  function signedIn(t, email) {
    ticket = t;
    $("signed-in").textContent = "Signed in as " + (typeof email === "string" ? email : "");
    show("confirm");
    say("");
    $("delete").focus();
  }

  $("confirm-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    say("Deleting...");
    var r = await client.deleteAccount(key, ticket);
    if (r.status === 200) {
      // A retried DELETE after a lost reply sees deleted 0: the first try did the delete.
      $("result").textContent = r.data.deleted === 0 && !r.unsure ? PA.TEXT.noPeers : PA.TEXT.deleted;
      show("done");
      say("Done.");
    } else if (r.status === 401 && (r.data.error === "ticket expired" || r.data.error === "invalid ticket")) {
      freshTurnstile();
      await restart(PA.TEXT.expired);
    } else {
      say(PA.errorText(r));
    }
  });

  async function init() {
    var h = location.hash;
    if (h.indexOf("ticket=") >= 0) {
      var p = new URLSearchParams(h.slice(1));
      history.replaceState(null, "", location.pathname);
      key = await PA.loadKey(sessionStorage);
      if (key && p.get("ticket")) {
        signedIn(p.get("ticket"), p.get("email"));
        return;
      }
      await restart(PA.TEXT.expired);
      return;
    }
    if (h.length > 1) {
      history.replaceState(null, "", location.pathname);
      await restart("Sign-in did not finish. Try again.");
      return;
    }
    await restart("");
  }

  init();
})();
