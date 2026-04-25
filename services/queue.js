// IndexedDB-backed offline queue for raw captures.
// Items are creates only — no sha. Treats 422 as success (file already there).
// Flush is sequential, insertion-order, stops on first failure.

import { putFile, GitHubAuthError, GitHubConflictError } from './github.js';

const DB_NAME = 'travel-vault';
const STORE   = 'raw-queue';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    // Same DB + version as db.js. The store was already declared in the
    // original onupgradeneeded, so opening here without an upgrade handler
    // simply attaches to the existing schema.
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(mode) {
  return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function emitChanged() {
  window.dispatchEvent(new CustomEvent('queue-changed'));
}

// item: { path, content, message }
export async function enqueue(item) {
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.add(item);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  emitChanged();
}

export async function count() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function clear() {
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  emitChanged();
}

async function readAll() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const items = [], keys = [];
    store.openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) { items.push(cur.value); keys.push(cur.key); cur.continue(); }
      else resolve({ items, keys });
    };
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

async function deleteKey(key) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function flush() {
  const { items, keys } = await readAll();
  let flushed = 0;
  let failed  = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key  = keys[i];
    try {
      await putFile(item.path, item.content, item.message);
      await deleteKey(key);
      flushed++;
      emitChanged();
    } catch (e) {
      // 422 after the github.js retry means the file already exists with a
      // different sha. For raw captures (creates only), that's "already done".
      if (e instanceof GitHubConflictError) {
        await deleteKey(key);
        flushed++;
        emitChanged();
        continue;
      }
      // Auth or network — stop. Caller decides what to do.
      failed = items.length - i;
      if (e instanceof GitHubAuthError) throw e;
      break;
    }
  }

  return { flushed, failed };
}
