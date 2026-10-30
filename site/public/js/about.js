// /about: platform tabs for the screenshots. Without this script the tab list stays
// hidden and every panel shows, one after another.
(function () {
  "use strict";
  var root = document.querySelector(".shots");
  if (!root) return;
  var list = root.querySelector('[role="tablist"]');
  var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });

  function select(i, focus) {
    tabs.forEach(function (t, j) {
      var on = j === i;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      panels[j].hidden = !on;
    });
    if (focus) tabs[i].focus();
  }

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(i, false); });
    t.addEventListener("keydown", function (e) {
      var n = tabs.length;
      var to = -1;
      if (e.key === "ArrowRight") to = (i + 1) % n;
      else if (e.key === "ArrowLeft") to = (i - 1 + n) % n;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = n - 1;
      if (to < 0) return;
      e.preventDefault();
      select(to, true);
    });
  });

  panels.forEach(function (p) {
    p.setAttribute("role", "tabpanel");
    p.tabIndex = 0;
  });
  root.classList.add("tabs-on");
  list.hidden = false;
  // A link such as /about#shots-iphone opens that tab.
  var start = panels.findIndex(function (p) { return "#" + p.id === location.hash; });
  select(start < 0 ? 0 : start, false);
})();

// /about: screenshot lightbox. Without this script each screenshot is a plain link to its PNG.
(function () {
  "use strict";
  var links = Array.prototype.slice.call(document.querySelectorAll(".shot-link"));
  var dlg = document.createElement("dialog");
  if (!links.length || typeof dlg.showModal !== "function") return;

  var chev = function (d) {
    return '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="' + d + '"/></svg>';
  };
  dlg.className = "lightbox";
  dlg.setAttribute("aria-labelledby", "lb-count");
  dlg.innerHTML =
    '<div class="lb-bar"><p class="lb-count" id="lb-count" aria-live="polite"></p>' +
    '<button type="button" class="lb-btn lb-close" aria-label="Close">' + chev("M6 6 L18 18 M18 6 L6 18") + "</button></div>" +
    '<div class="lb-stage"><button type="button" class="lb-btn lb-prev" aria-label="Previous screenshot">' + chev("M15 5 L8 12 L15 19") + "</button>" +
    '<figure class="lb-fig"><picture><source type="image/webp"><img alt=""></picture><figcaption></figcaption></figure>' +
    '<button type="button" class="lb-btn lb-next" aria-label="Next screenshot">' + chev("M9 5 L16 12 L9 19") + "</button></div>";
  document.body.appendChild(dlg);

  var count = dlg.querySelector(".lb-count");
  var source = dlg.querySelector("source");
  var img = dlg.querySelector("img");
  var cap = dlg.querySelector("figcaption");
  var set = [];
  var at = 0;
  var opener = null;

  function show(i) {
    var n = set.length;
    at = (i + n) % n;
    var a = set[at];
    var thumb = a.querySelector("img");
    var srcset = a.querySelector("source").getAttribute("srcset").split(",");
    var fig = a.closest("figure").querySelector("figcaption");
    var platform = a.closest(".shot-panel").querySelector(".panel-title").textContent;
    source.setAttribute("srcset", srcset[srcset.length - 1].trim().split(/\s+/)[0]);
    img.src = a.getAttribute("href");
    img.alt = thumb.alt;
    img.setAttribute("width", thumb.getAttribute("width"));
    img.setAttribute("height", thumb.getAttribute("height"));
    cap.textContent = fig ? fig.textContent : thumb.alt;
    count.textContent = platform + " screenshot " + (at + 1) + " of " + n;
  }

  function step(d) { if (set.length > 1) show(at + d); }

  links.forEach(function (a) {
    a.setAttribute("aria-haspopup", "dialog");
    a.addEventListener("click", function (e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      opener = a;
      set = Array.prototype.slice.call(a.closest(".shot-panel").querySelectorAll(".shot-link"));
      show(set.indexOf(a));
      document.documentElement.classList.add("lb-open");
      dlg.showModal();
      dlg.querySelector(".lb-close").focus();
    });
  });

  dlg.querySelector(".lb-close").addEventListener("click", function () { dlg.close(); });
  dlg.querySelector(".lb-prev").addEventListener("click", function () { step(-1); });
  dlg.querySelector(".lb-next").addEventListener("click", function () { step(1); });
  // A click on the dimmed area around the image closes.
  dlg.addEventListener("click", function (e) {
    var t = e.target;
    if (t === dlg || t.classList.contains("lb-stage") || t.classList.contains("lb-bar")) dlg.close();
  });
  dlg.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else return;
    e.preventDefault();
  });
  dlg.addEventListener("close", function () {
    document.documentElement.classList.remove("lb-open");
    if (opener) opener.focus();
    opener = null;
  });

  var x0 = null;
  var y0 = 0;
  dlg.addEventListener("touchstart", function (e) {
    x0 = e.touches.length === 1 ? e.touches[0].clientX : null;
    y0 = x0 === null ? 0 : e.touches[0].clientY;
  }, { passive: true });
  dlg.addEventListener("touchend", function (e) {
    if (x0 === null) return;
    var dx = e.changedTouches[0].clientX - x0;
    var dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  }, { passive: true });
})();
