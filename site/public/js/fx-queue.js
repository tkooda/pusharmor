// Firefox fallback queue in IndexedDB, shared by /fx/sw.js (importScripts) and /fx/open.
// Entries {id, M, received (ms)}. Cap 150 entries (oldest dropped); entries older than
// 14 days are dropped. Defines the global PAQ.
(function (g) {
  "use strict";

  var CAP = 150;
  var MAX_AGE_MS = 14 * 24 * 3600 * 1000;
  var DB = "pa-fx";
  var STORE = "queue";

  // Pure rule: which entries stay. Returns {keep, drop} (arrays of entries, keep sorted by id).
  function select(entries, now) {
    var sorted = entries.slice().sort(function (a, b) { return a.id - b.id; });
    var fresh = [];
    var drop = [];
    sorted.forEach(function (e) {
      if (now - e.received > MAX_AGE_MS) drop.push(e); else fresh.push(e);
    });
    var over = fresh.length - CAP;
    if (over > 0) drop = drop.concat(fresh.splice(0, over));
    return { keep: fresh, drop: drop };
  }

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function open() {
    var r = g.indexedDB.open(DB, 1);
    r.onupgradeneeded = function () {
      r.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    return req(r);
  }

  async function withStore(mode, fn) {
    var db = await open();
    try {
      var tx = db.transaction(STORE, mode);
      var done = new Promise(function (resolve, reject) {
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
      var out = await fn(tx.objectStore(STORE));
      await done;
      return out;
    } finally {
      db.close();
    }
  }

  // Applies the cap and age rule; returns the kept entries, oldest first.
  function prune(now) {
    return withStore("readwrite", async function (st) {
      var s = select(await req(st.getAll()), now);
      s.drop.forEach(function (e) { st.delete(e.id); });
      return s.keep;
    });
  }

  async function add(M, now) {
    await withStore("readwrite", function (st) {
      return req(st.add({ M: M, received: now }));
    });
    return prune(now);
  }

  function list(now) {
    return prune(now);
  }

  function del(id) {
    return withStore("readwrite", function (st) {
      return req(st.delete(id));
    });
  }

  g.PAQ = { CAP: CAP, MAX_AGE_MS: MAX_AGE_MS, select: select, add: add, list: list, del: del };
})(this);
