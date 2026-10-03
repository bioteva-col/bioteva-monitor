/*
 * BioTeva Monitor — almacenamiento local (IndexedDB).
 *
 * Todo queda en ESTE navegador / perfil de Chrome: funciona sin internet y
 * sobrevive a reinicios. Cada instalación (página local, app instalada,
 * extensión) tiene su propia base; para moverla se usa Respaldo JSON.
 *
 * Almacenes: kv (configuración y sensores), readings, events, snapshots, reports.
 * Las marcas de tiempo son milisegundos epoch (UTC); se muestran en hora local.
 */
(function (root) {
  "use strict";

  var DB_NAME = "bioteva-monitor", DB_VERSION = 1;

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("Transacción abortada")); };
    });
  }

  function open() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error("Este navegador no permite almacenamiento local (IndexedDB)."));
      var r = root.indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
        if (!db.objectStoreNames.contains("readings")) {
          var rs = db.createObjectStore("readings", { keyPath: "id" });
          rs.createIndex("ts", "ts");
          rs.createIndex("sensor_ts", ["sensorId", "ts"]);
          rs.createIndex("source", "source");
        }
        if (!db.objectStoreNames.contains("events")) {
          var es = db.createObjectStore("events", { keyPath: "id" });
          es.createIndex("ts", "ts");
          es.createIndex("sensor_ts", ["sensorId", "ts"]);
          es.createIndex("source", "source");
        }
        if (!db.objectStoreNames.contains("snapshots")) {
          var ss = db.createObjectStore("snapshots", { keyPath: "id" });
          ss.createIndex("ts", "ts");
        }
        if (!db.objectStoreNames.contains("reports")) {
          var rp = db.createObjectStore("reports", { keyPath: "id" });
          rp.createIndex("date", "date");
        }
      };
      r.onsuccess = function () { resolve(api(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error("La base local está bloqueada por otra pestaña del monitor. Ciérrala e intenta de nuevo.")); };
    });
  }

  function api(db) {
    function store(name, mode) { return db.transaction(name, mode || "readonly").objectStore(name); }
    function getAll(src, range) { return req(src.getAll(range)); }

    return {
      db: db,

      getKV: function (k) { return req(store("kv").get(k)).then(function (r) { return r ? r.v : undefined; }); },
      setKV: function (k, v) {
        var tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put({ k: k, v: v });
        return done(tx);
      },

      /** Guarda lecturas y eventos de un ciclo en UNA transacción. */
      saveCycle: function (readings, events) {
        var tx = db.transaction(["readings", "events"], "readwrite");
        readings.forEach(function (r) { tx.objectStore("readings").put(r); });
        events.forEach(function (e) { tx.objectStore("events").put(e); });
        return done(tx);
      },
      putReading: function (r) {
        var tx = db.transaction("readings", "readwrite");
        tx.objectStore("readings").put(r);
        return done(tx);
      },

      readingsRange: function (from, to, sensorId) {
        if (sensorId) return getAll(store("readings").index("sensor_ts"), IDBKeyRange.bound([sensorId, from], [sensorId, to]));
        return getAll(store("readings").index("ts"), IDBKeyRange.bound(from, to));
      },
      lastReading: function (sensorId) {
        return new Promise(function (resolve, reject) {
          var r = store("readings").index("sensor_ts").openCursor(IDBKeyRange.bound([sensorId, -Infinity], [sensorId, Infinity]), "prev");
          r.onsuccess = function () { resolve(r.result ? r.result.value : null); };
          r.onerror = function () { reject(r.error); };
        });
      },
      countReadings: function () { return req(store("readings").count()); },

      eventsRange: function (from, to, sensorId) {
        if (sensorId) return getAll(store("events").index("sensor_ts"), IDBKeyRange.bound([sensorId, from], [sensorId, to]));
        return getAll(store("events").index("ts"), IDBKeyRange.bound(from, to));
      },
      ackEvent: function (id) {
        var tx = db.transaction("events", "readwrite"), os = tx.objectStore("events");
        var g = os.get(id);
        g.onsuccess = function () { if (g.result && !g.result.ack) { g.result.ack = Date.now(); os.put(g.result); } };
        return done(tx);
      },
      ackAll: function () {
        var tx = db.transaction("events", "readwrite"), os = tx.objectStore("events"), n = 0;
        var c = os.openCursor();
        c.onsuccess = function () {
          var cur = c.result;
          if (!cur) return;
          var e = cur.value;
          if (!e.ack && e.severity !== "INFO") { e.ack = Date.now(); cur.update(e); n++; }
          cur.continue();
        };
        return done(tx).then(function () { return n; });
      },

      addSnapshot: function (blob, meta) {
        var id = "snap-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
        var tx = db.transaction("snapshots", "readwrite");
        tx.objectStore("snapshots").put({ id: id, ts: meta.ts, sensorId: meta.sensorId || null, readingId: meta.readingId || null, blob: blob, bytes: blob.size });
        return done(tx).then(function () { return id; });
      },
      getSnapshot: function (id) { return req(store("snapshots").get(id)); },
      /** Borra evidencias anteriores a `beforeTs` (retención configurable). */
      purgeSnapshots: function (beforeTs) {
        var tx = db.transaction("snapshots", "readwrite"), n = 0;
        var c = tx.objectStore("snapshots").index("ts").openCursor(IDBKeyRange.upperBound(beforeTs, true));
        c.onsuccess = function () { var cur = c.result; if (!cur) return; cur.delete(); n++; cur.continue(); };
        return done(tx).then(function () { return n; });
      },
      countSnapshots: function () { return req(store("snapshots").count()); },

      addReport: function (rep) {
        var tx = db.transaction("reports", "readwrite");
        tx.objectStore("reports").put(rep);
        return done(tx);
      },
      listReports: function () {
        return getAll(store("reports")).then(function (all) { return all.sort(function (a, b) { return b.generatedAt - a.generatedAt; }); });
      },
      getReport: function (id) { return req(store("reports").get(id)); },

      /** Elimina los datos del modo simulación (lecturas y eventos). */
      deleteSimulated: function () {
        var tx = db.transaction(["readings", "events"], "readwrite"), n = { readings: 0, events: 0 };
        ["readings", "events"].forEach(function (name) {
          var c = tx.objectStore(name).index("source").openCursor(IDBKeyRange.only("simulation"));
          c.onsuccess = function () { var cur = c.result; if (!cur) return; cur.delete(); n[name]++; cur.continue(); };
        });
        return done(tx).then(function () { return n; });
      },
      hasSimulated: function () {
        return req(store("readings").index("source").count(IDBKeyRange.only("simulation"))).then(function (n) { return n > 0; });
      },

      /** Respaldo completo (sin fotos) para mover los datos a otro equipo/navegador. */
      exportBackup: function () {
        return Promise.all([getAll(store("kv")), getAll(store("readings")), getAll(store("events")), getAll(store("reports"))]).then(function (r) {
          return { app: "bioteva-monitor", version: 1, exportedAt: Date.now(), kv: r[0], readings: r[1], events: r[2], reports: r[3] };
        });
      },
      importBackup: function (data) {
        if (!data || data.app !== "bioteva-monitor") return Promise.reject(new Error("El archivo no es un respaldo de BioTeva Monitor."));
        var tx = db.transaction(["kv", "readings", "events", "reports"], "readwrite");
        (data.kv || []).forEach(function (x) { tx.objectStore("kv").put(x); });
        (data.readings || []).forEach(function (x) { tx.objectStore("readings").put(x); });
        (data.events || []).forEach(function (x) { tx.objectStore("events").put(x); });
        (data.reports || []).forEach(function (x) { tx.objectStore("reports").put(x); });
        return done(tx).then(function () { return { readings: (data.readings || []).length, events: (data.events || []).length }; });
      },
    };
  }

  root.MonStore = { open: open };
})(typeof self !== "undefined" ? self : globalThis);
