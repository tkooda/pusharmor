// /fx/open: last-resort bridge. On {pa: "fx-ready"} from the add-on content script, posts each
// queued entry as {pa: "fx-msg", id, M} and deletes it only after {pa: "fx-ack", id}.
// Needs /js/fx-queue.js.
(function () {
  "use strict";

  var status = document.getElementById("status");
  var ready = false;
  var pending = null;

  var timer = setTimeout(function () {
    if (!ready) status.textContent = "Install the PushArmor add-on";
  }, 3000);

  window.addEventListener("message", function (e) {
    if (e.source !== window || e.origin !== location.origin || !e.data) return;
    if (e.data.pa === "fx-ready" && !ready) {
      ready = true;
      clearTimeout(timer);
      drain();
    } else if (e.data.pa === "fx-ack" && pending && e.data.id === pending.id) {
      var p = pending;
      pending = null;
      p.resolve();
    }
  });

  async function drain() {
    var entries = await window.PAQ.list(Date.now());
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      await new Promise(function (resolve) {
        pending = { id: ent.id, resolve: resolve };
        window.postMessage({ pa: "fx-msg", id: ent.id, M: ent.M }, location.origin);
      });
      await window.PAQ.del(ent.id);
    }
    status.textContent = "Delivered to PushArmor";
  }
})();
