// Firefox fallback service worker, scope /fx/. No fetch handler.
// push: show a notification at once, queue M, forward M to /fx/fwd. The add-on catches and
// cancels that fetch (it then rejects with TypeError); any HTTP response (404 from the edge)
// means the add-on did not catch it, so the notification stays and its click opens /fx/open.
importScripts("/js/fx-queue.js");

var FORWARD_URL = "https://pusharmor.com/fx/fwd";
var OPEN_URL = "/fx/open";
var CLOSE_AFTER_MS = 4000;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

self.addEventListener("push", function (event) {
  var M = event.data ? event.data.text() : "";
  var tag = "m-" + self.crypto.randomUUID();
  event.waitUntil((async function () {
    await self.registration.showNotification("PushArmor", { body: "New message", tag: tag });
    if (!M) return;
    await self.PAQ.add(M, Date.now());
    var caught = false;
    try {
      await fetch(FORWARD_URL, { method: "POST", body: M });
    } catch (e) {
      caught = e instanceof TypeError;
    }
    if (caught) {
      await sleep(CLOSE_AFTER_MS);
      var list = await self.registration.getNotifications({ tag: tag });
      list.forEach(function (n) { n.close(); });
    }
  })());
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil((async function () {
    var wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < wins.length; i++) {
      if (new URL(wins[i].url).pathname === OPEN_URL && "focus" in wins[i]) {
        // Reload so the page drains the queue again (the add-on posts fx-ready on load).
        var c = await wins[i].focus();
        return c.navigate(c.url).catch(function () {});
      }
    }
    return self.clients.openWindow(OPEN_URL);
  })());
});
