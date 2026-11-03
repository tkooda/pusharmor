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

// The relay server's test push ({"check":1}) is not a message: no notification, nothing to forward.
function isCheck(M) {
  try {
    var v = JSON.parse(M);
    return typeof v === "object" && v !== null && v.check === 1;
  } catch (e) {
    return false;
  }
}

self.addEventListener("push", function (event) {
  var M = event.data ? event.data.text() : "";
  if (isCheck(M)) return;
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

// The push service dropped or replaced the subscription: subscribe again with the same key and
// forward the new one as "sub:" + JSON, so the add-on stores it and tells the relay server.
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil((async function () {
    var sub = event.newSubscription || (await self.registration.pushManager.getSubscription());
    if (!sub) {
      var key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      if (!key) return;
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    var j = sub.toJSON();
    var body = "sub:" + JSON.stringify({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
    await fetch(FORWARD_URL, { method: "POST", body: body }).catch(function () {});
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
