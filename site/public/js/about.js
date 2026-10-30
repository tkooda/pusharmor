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
