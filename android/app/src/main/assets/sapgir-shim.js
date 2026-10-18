/**
 * Android WebView shim — injected into app.html before the app modules run.
 *
 * The extension relies on `chrome.storage.local`. In a WebView there is no
 * `chrome.storage`, so this file implements the subset that js/storage.js
 * uses on top of IndexedDB. IndexedDB is used instead of localStorage because
 * conversations store base64 images and easily exceed the ~5 MB localStorage
 * quota.
 */
(function () {
  'use strict';

  if (window.chrome && window.chrome.storage && window.chrome.storage.local) return;

  var DB_NAME = 'sapgir-storage';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    }
    return dbPromise;
  }

  function readValue(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function writeItems(items) {
    var keys = Object.keys(items || {});
    if (!keys.length) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        keys.forEach(function (key) { store.put(items[key], key); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function deleteKeys(keys) {
    if (!keys.length) return Promise.resolve();
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        keys.forEach(function (key) { store.delete(key); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function readAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var keysRequest = store.getAllKeys();
        var valuesRequest = store.getAll();
        tx.oncomplete = function () {
          var out = {};
          var keys = keysRequest.result || [];
          var values = valuesRequest.result || [];
          keys.forEach(function (key, index) { out[key] = values[index]; });
          resolve(out);
        };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function clearAll() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getValues(keys) {
    if (keys === null || keys === undefined) return readAll();

    if (typeof keys === 'string') {
      return readValue(keys).then(function (value) {
        var out = {};
        if (value !== undefined) out[keys] = value;
        return out;
      });
    }

    if (Array.isArray(keys)) {
      return Promise.all(keys.map(function (key) {
        return readValue(key).then(function (value) { return [key, value]; });
      })).then(function (pairs) {
        var out = {};
        pairs.forEach(function (pair) {
          if (pair[1] !== undefined) out[pair[0]] = pair[1];
        });
        return out;
      });
    }

    if (typeof keys === 'object') {
      var names = Object.keys(keys);
      return Promise.all(names.map(function (name) {
        return readValue(name).then(function (value) { return [name, value]; });
      })).then(function (pairs) {
        var out = {};
        pairs.forEach(function (pair, index) {
          out[pair[0]] = pair[1] !== undefined ? pair[1] : keys[names[index]];
        });
        return out;
      });
    }

    return Promise.resolve({});
  }

  var local = {
    get: function (keys) { return getValues(keys); },
    set: function (items) { return writeItems(items); },
    remove: function (keys) {
      return deleteKeys(Array.isArray(keys) ? keys : [keys]);
    },
    clear: function () { return clearAll(); },
  };

  try {
    window.chrome = window.chrome || {};
  } catch (_) {
    Object.defineProperty(window, 'chrome', { value: {}, configurable: true });
  }

  try {
    window.chrome.storage = window.chrome.storage || {};
    window.chrome.storage.local = local;
  } catch (_) {
    try {
      Object.defineProperty(window.chrome, 'storage', {
        value: { local: local },
        configurable: true,
      });
    } catch (_) {
      // window.chrome can be non-extensible in some WebView builds; the app
      // also checks this well-known hook.
    }
  }

  // Fallback hook used by js/storage.js when chrome.storage cannot be patched.
  window.__sapgirStorage = local;
})();
