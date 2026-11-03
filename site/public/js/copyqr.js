// Copy and QR code buttons. A button with data-copy="ID" copies the text of the element
// with that id (the href for a link). A button with data-qr="ID" shows that URL as a QR code
// in a dialog. The buttons are hidden in the HTML; this script shows them, so without
// JavaScript the page shows only the text. Needs /js/qrcode.js first. Defines the global PACQ.
(function (g) {
  "use strict";

  // The exact text a button acts on: a link's href, else the element's text.
  function targetText(el) {
    return el.tagName === "A" ? el.getAttribute("href") : el.textContent;
  }

  // QR modules for text: rows of booleans, true is dark. Byte mode, level M, smallest version.
  function matrix(text) {
    var q = g.qrcode(0, "M");
    q.addData(text, "Byte");
    q.make();
    var n = q.getModuleCount();
    var rows = [];
    for (var r = 0; r < n; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(q.isDark(r, c));
      rows.push(row);
    }
    return rows;
  }

  var SVG = "http://www.w3.org/2000/svg";

  // Dark modules on white with a 4-module quiet zone, as one path.
  function qrSvg(text) {
    var m = matrix(text);
    var size = m.length + 8;
    var d = "";
    for (var r = 0; r < m.length; r++) {
      for (var c = 0; c < m.length; c++) if (m[r][c]) d += "M" + (c + 4) + " " + (r + 4) + "h1v1h-1z";
    }
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("class", "qr");
    svg.setAttribute("role", "img");
    svg.setAttribute("shape-rendering", "crispEdges");
    var bg = document.createElementNS(SVG, "rect");
    bg.setAttribute("width", String(size));
    bg.setAttribute("height", String(size));
    bg.setAttribute("fill", "#ffffff");
    var p = document.createElementNS(SVG, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "#000000");
    svg.appendChild(bg);
    svg.appendChild(p);
    return svg;
  }

  function wire() {
    var doc = g.document;
    var dialog = null;
    var opener = null;

    function showQr(btn, text) {
      if (!dialog) {
        dialog = doc.createElement("dialog");
        dialog.className = "qr-dialog";
        dialog.setAttribute("aria-labelledby", "qr-title");
        dialog.innerHTML = '<div class="qr-box"><h2 id="qr-title"></h2><div class="qr-code"></div>' +
          '<p class="mono"></p><button type="button" class="secondary">Close</button></div>';
        dialog.querySelector("button").addEventListener("click", function () { dialog.close(); });
        // A click on the backdrop lands on the dialog itself, outside .qr-box.
        dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
        dialog.addEventListener("close", function () { if (opener) opener.focus(); });
        doc.body.appendChild(dialog);
      }
      opener = btn;
      var label = btn.getAttribute("aria-label").replace(/^Show /, "");
      dialog.querySelector("h2").textContent = label.charAt(0).toUpperCase() + label.slice(1);
      var box = dialog.querySelector(".qr-code");
      box.textContent = "";
      var svg = qrSvg(text);
      svg.setAttribute("aria-label", label);
      box.appendChild(svg);
      dialog.querySelector("p").textContent = text;
      dialog.showModal();
      dialog.querySelector("button").focus();
    }

    // An empty live region per copy button, after the QR button when there is one, so no
    // button moves when the message shows.
    function status(btn) {
      var at = btn.nextElementSibling && btn.nextElementSibling.hasAttribute("data-qr") ? btn.nextElementSibling : btn;
      var s = doc.createElement("span");
      s.className = "copied";
      s.setAttribute("role", "status");
      at.parentNode.insertBefore(s, at.nextSibling);
      return s;
    }

    function say(s, msg) {
      s.textContent = msg;
      clearTimeout(s.pacqTimer);
      s.pacqTimer = setTimeout(function () { s.textContent = ""; }, 2000);
    }

    var btns = doc.querySelectorAll("button[data-copy], button[data-qr]");
    Array.prototype.forEach.call(btns, function (btn) {
      var copy = btn.hasAttribute("data-copy");
      var el = doc.getElementById(btn.getAttribute(copy ? "data-copy" : "data-qr"));
      if (!el) return;
      if (copy && !(g.navigator.clipboard && g.navigator.clipboard.writeText)) return;
      if (!copy && typeof doc.createElement("dialog").showModal !== "function") return;
      var s = copy ? status(btn) : null;
      btn.addEventListener("click", function () {
        var text = targetText(el);
        if (!copy) return showQr(btn, text);
        g.navigator.clipboard.writeText(text).then(function () { say(s, "Copied"); }, function () { say(s, "Not copied"); });
      });
      btn.hidden = false;
    });
  }

  g.PACQ = { targetText: targetText, matrix: matrix };
  if (g.document) wire();
})(this);
