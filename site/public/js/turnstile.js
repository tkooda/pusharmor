// /turnstile: renders the Turnstile widget (action "email") and returns each token to the host:
// extension or same-site iframe (parent.postMessage to the origin in #o=), Android WebView
// (paTurnstile web message listener) or iOS WKWebView (messageHandlers.paTurnstile).
(function () {
  "use strict";

  var ORIGIN_RULES = [
    /^chrome-extension:\/\/[a-p]{32}$/,
    /^moz-extension:\/\/[0-9a-f-]{36}$/,
    /^https:\/\/pusharmor\.com$/
  ];

  function allowedOrigin(o) {
    if (typeof o !== "string") return null;
    for (var i = 0; i < ORIGIN_RULES.length; i++) {
      if (ORIGIN_RULES[i].test(o)) return o;
    }
    return null;
  }

  var parentOrigin = allowedOrigin(new URLSearchParams(location.hash.slice(1)).get("o"));
  var box = document.getElementById("ts");
  var status = document.getElementById("status");

  function send(token) {
    if (parentOrigin && window.parent !== window) {
      window.parent.postMessage({ pa: "turnstile", token: token }, parentOrigin);
    }
    if (window.paTurnstile && typeof window.paTurnstile.postMessage === "function") {
      window.paTurnstile.postMessage(token);
    }
    var wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.paTurnstile;
    if (wk) wk.postMessage(token);
    status.textContent = "Done";
  }

  // Called by api.js (onload=paTurnstileLoad). Tokens are valid 300 s and single use:
  // on expiry reset the widget, which sends a fresh token.
  window.paTurnstileLoad = function () {
    var id = window.turnstile.render(box, {
      sitekey: box.getAttribute("data-sitekey"),
      action: "email",
      "refresh-expired": "manual",
      callback: send,
      "expired-callback": function () {
        status.textContent = "";
        window.turnstile.reset(id);
      }
    });
  };
})();
