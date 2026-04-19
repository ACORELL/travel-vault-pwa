// IndexedDB — vault handle persistence + offline queues
const DB_NAME = 'travel-vault';
const DB_VER  = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains('handles'))   db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('log-queue')) db.createObjectStore('log-queue', { autoIncrement: true });
      if (!db.objectStoreNames.contains('raw-queue')) db.createObjectStore('raw-queue', { autoIncrement: true });
    };
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = () => rej(req.error);
  });
}

function rw(store, fn) {
  return open().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req?.result ?? undefined);
    tx.onerror    = () => rej(tx.error);
  }));
}

function ro(store, fn) {
  return open().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(store, 'readonly');
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req?.result ?? undefined);
    tx.onerror    = () => rej(tx.error);
  }));
}

function scanStore(storeName) {
  return open().then(db => new Promise((res, rej) => {
    const tx    = db.transaction(storeName, 'readonly');
    const items = [], keys = [];
    tx.objectStore(storeName).openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) { items.push(cur.value); keys.push(cur.key); cur.continue(); }
      else res({ items, keys });
    };
    tx.onerror = () => rej(tx.error);
  }));
}

function deleteKeys(storeName, keys) {
  return open().then(db => new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    const s  = tx.objectStore(storeName);
    keys.forEach(k => s.delete(k));
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  }));
}

export const saveVaultHandle  = h    => rw('handles',   s => s.put(h, 'vault'));
export const getVaultHandle   = ()   => ro('handles',   s => s.get('vault'));
export const enqueueLogEntry  = item => rw('log-queue', s => s.add(item));
export const enqueueRaw       = item => rw('raw-queue', s => s.add(item));
export const getLogQueue      = ()   => scanStore('log-queue');
export const getRawQueue      = ()   => scanStore('raw-queue');
export const clearLogKeys     = keys => deleteKeys('log-queue', keys);
export const clearRawKeys     = keys => deleteKeys('raw-queue', keys);
