// /fx/setup: one click registers /fx/sw.js (scope /fx/), subscribes to push with the fixed
// VAPID public key and posts {pa: "fx-sub", endpoint, p256dh, auth} to the window for the
// add-on content script. Needs /js/pa-web.js (PA.b64url).
(function () {
  "use strict";

  // The fixed VAPID public key (b64url of the 65-byte point), same as Chrome and autopush.
  var VAPID_PUBLIC_KEY = "VAPID_PUBLIC_KEY_PLACEHOLDER";
  var SUBSCRIBE_TIMEOUT_MS = 15000;

  var status = document.getElementById("status");
  var start = document.getElementById("start");
  var retry = document.getElementById("retry");
  var android = /Android/.test(navigator.userAgent);

  function say(text, canRetry) {
    status.textContent = text;
    retry.hidden = !canRetry;
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error("timeout")); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  async function run() {
    say("", false);
    var perm = await Notification.requestPermission();
    if (perm !== "granted") {
      say("Allow notifications for pusharmor.com in the address bar, then Retry", true);
      return;
    }
    var sub = null;
    try {
      await navigator.serviceWorker.register("/fx/sw.js", { scope: "/fx/" });
      var reg = await navigator.serviceWorker.ready;
      sub = await withTimeout(reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: VAPID_PUBLIC_KEY
      }), SUBSCRIBE_TIMEOUT_MS);
    } catch (e) {
      sub = null;
    }
    if (!sub) {
      if (android) {
        say("This Firefox build cannot receive push (no Google Play services)", false);
      } else {
        say("Firefox could not create a push subscription (offline, or push is disabled in this profile)", true);
      }
      return;
    }
    window.postMessage({
      pa: "fx-sub",
      endpoint: sub.endpoint,
      p256dh: window.PA.b64url(new Uint8Array(sub.getKey("p256dh"))),
      auth: window.PA.b64url(new Uint8Array(sub.getKey("auth")))
    }, location.origin);
    start.hidden = true;
    say("Done, you can close this tab", false);
  }

  start.addEventListener("click", run);
  retry.addEventListener("click", run);
})();
