// /auth/cli: log in for the command line. Link fragment #<r|l|d>.<k16>; email code or OAuth
// returns a one-time cli_code to paste into the terminal. Needs /js/pa-web.js.
(function () {
  "use strict";

  var SITE = "https://pusharmor.com";
  var PA = window.PA;
  var client = new PA.Client();
  var link = null;
  var tsToken = null;
  var requestToken = null;

  function $(id) { return document.getElementById(id); }
  var status = $("status");
  var ts = $("ts");

  function say(text) { status.textContent = text; }

  function show(step) {
    $("bad").hidden = step !== "bad";
    $("prove").hidden = step !== "prove" && step !== "code";
    $("start").hidden = step !== "prove";
    $("code-form").hidden = step !== "code";
    $("done").hidden = step !== "done";
  }

  function freshTurnstile() {
    tsToken = null;
    try { ts.contentWindow.location.reload(); } catch (e) { /* same origin; ignore */ }
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== SITE || e.source !== ts.contentWindow) return;
    var d = e.data;
    if (d && d.pa === "turnstile" && typeof d.token === "string") tsToken = d.token;
    if (d && d.pa === "turnstile-size" && typeof d.h === "number") ts.style.height = Math.min(600, Math.max(65, Math.ceil(d.h))) + "px";
  });

  $("email-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = $("email").value.trim();
    if (!PA.isAscii(email)) { say(PA.TEXT.badEmail); return; }
    if (!tsToken) { say("Wait for the check above the button to finish, then try again."); return; }
    var token = tsToken;
    freshTurnstile();
    say("Sending code...");
    var r = await client.request("POST", "/v1/auth/email", PA.cliEmailBody(email, link, token), null);
    if (r.status === 200 && typeof r.data.request_token === "string") {
      requestToken = r.data.request_token;
      $("sent-to").textContent = "We sent a 6-character code to " + email + ".";
      show("code");
      say("");
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
    if (r.status === 200 && typeof r.data.cli_code === "string") {
      finished(r.data.cli_code, r.data.email);
    } else {
      say(PA.errorText(r));
    }
  });

  $("other-email").addEventListener("click", function () {
    $("code").value = "";
    show("prove");
    say("");
    $("email").focus();
  });

  function oauth(provider) {
    return function () { location.assign(PA.cliOAuthUrl(provider, link)); };
  }
  $("google").addEventListener("click", oauth("google"));
  $("apple").addEventListener("click", oauth("apple"));

  function finished(code, email) {
    $("cli-code").textContent = code;
    $("who").textContent = typeof email === "string" && email ? "Logged in as " + email + "." : "";
    show("done");
    say("");
    $("done-h").focus();
  }

  $("copy").addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText($("cli-code").textContent);
      say("Copied");
    } catch (e) {
      say("Could not copy. Select the code and copy it by hand.");
    }
  });

  function init() {
    var h = location.hash;
    history.replaceState(null, "", location.pathname);
    var res = PA.parseCliResult(h);
    if (res && res.code) { finished(res.code, res.email); return; }
    if (res) {
      show("bad");
      say(res.error === "cancelled" ? "Login was cancelled. Run the command again to get a new link." : "Login did not finish. Run the command again to get a new link.");
      return;
    }
    link = PA.parseCliLink(h);
    if (!link) { show("bad"); return; }
    show("prove");
  }

  init();
})();
