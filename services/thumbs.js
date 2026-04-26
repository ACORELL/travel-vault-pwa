// Web-quality thumbnail blobs for own captures, kept in IDB until sync.
//
// generateFromFile resizes via <canvas> to long-edge 1600 px at JPEG q=75
// (~150-250 KB per photo, ~300 MB for a 30-day 50-photos-per-day trip —
// comfortable under GitHub's 5 GB recommendation).
//
// The full-resolution File from the camera input is *never* persisted by
// the PWA. It stays on the phone's camera roll for the assembly PWA at
// home (Phase 6). Only the resized thumbnail is stored locally and pushed.

const DB_NAME     = 'tv-thumbs';
const STORE_BLOBS = 'thumbs-local';
const STORE_SYNC  = 'thumbs-sync-state';

const LONG_EDGE = 1600;
const QUALITY   = 0.75;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'ref' });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC)) {
        db.createObjectStore(STORE_SYNC, { keyPath: 'ref' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then(db => db.transaction(store, mode).objectStore(store));
}

// ─── Generate a web-quality thumbnail Blob from a File ────────────────────────
// Aspect ratio preserved; long edge clamped to LONG_EDGE so portrait and
// landscape both fit the budget.
export async function generateFromFile(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = scaledDims(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });
}

function scaledDims(w, h) {
  if (w <= LONG_EDGE && h <= LONG_EDGE) return { width: w, height: h };
  if (w >= h) return { width: LONG_EDGE, height: Math.round(h * LONG_EDGE / w) };
  return { width: Math.round(w * LONG_EDGE / h), height: LONG_EDGE };
}

// ─── Local blob store ─────────────────────────────────────────────────────────
export async function storeLocal(ref, blob) {
  const store = await tx(STORE_BLOBS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ ref, blob });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

export async function getLocalBlob(ref) {
  const store = await tx(STORE_BLOBS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(ref);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror   = () => reject(req.error);
  });
}

// Per-session URL cache — URL.createObjectURL is cheap but the rendered <img>
// re-evaluates src on every render, so we hand back the same URL each time.
// URLs are released when the page unloads.
const _urls = new Map();

export async function getLocalUrl(ref) {
  if (_urls.has(ref)) return _urls.get(ref);
  const blob = await getLocalBlob(ref);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _urls.set(ref, url);
  return url;
}

// ─── Sync state ───────────────────────────────────────────────────────────────
// "synced" = the thumb has been PUT to the data repo at least once. Thumb
// paths are unique per ref, so the queue's create-only contract applies and
// we don't need to store a sha.
export async function unsyncedRefs(date) {
  const [refs, synced] = await Promise.all([listLocalRefsForDate(date), listSyncedSet()]);
  return refs.filter(r => !synced.has(r));
}

async function listLocalRefsForDate(date) {
  const prefix = `${date}_`;
  const store  = await tx(STORE_BLOBS, 'readonly');
  return new Promise((resolve, reject) => {
    const refs = [];
    store.openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) {
        if (cur.value.ref.startsWith(prefix)) refs.push(cur.value.ref);
        cur.continue();
      } else resolve(refs);
    };
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

async function listSyncedSet() {
  const store = await tx(STORE_SYNC, 'readonly');
  return new Promise((resolve, reject) => {
    const set = new Set();
    store.openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) { set.add(cur.value.ref); cur.continue(); }
      else resolve(set);
    };
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

export async function markSynced(ref) {
  const store = await tx(STORE_SYNC, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ ref, syncedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// Used after a thumb has been replaced (edit-photo flow): the local blob
// is overwritten, but the previously-synced version still lives in the
// data repo. Removing the sync-state entry surfaces the ref again in
// unsyncedRefs so the next sync re-uploads it.
export async function markUnsynced(ref) {
  const store = await tx(STORE_SYNC, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(ref);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
