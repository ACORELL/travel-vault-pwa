// Web-quality thumbnail blobs for own captures.
//
// generateFromFile resizes via <canvas> to long-edge 1200 px at JPEG q=75
// (~80-140 KB per photo, ~150 MB for a 30-day 50-photos-per-day trip).
// Thumbs are only used for at-a-glance identification in the PWA timeline
// — the assembly PWA at home pulls full-resolution originals from the
// camera roll for the daily snapshot PDFs.
//
// The full-resolution File from the camera input is *never* persisted by
// the PWA. It stays on the phone's camera roll for the assembly PWA at
// home (Phase 6). Only the resized thumbnail is stored locally and pushed
// to the data repo via tabs/log/log.js (direct putFile or queued put-thumb
// op when offline). Phase 5 dropped sync-state tracking — the upload happens
// inline with the entry mutation, not as a deferred sweep.

const DB_NAME     = 'tv-thumbs';
const STORE_BLOBS = 'thumbs-local';
// The Phase-4 'thumbs-sync-state' store still exists in upgraded installs at
// IDB v1 but is no longer read or written. PHASE5.md §11 marks it as harmless
// vestigial data — not worth a schema bump to drop.

const LONG_EDGE = 1200;
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
// Records carry the GitHub blob sha so refresh.syncThumbs can skip refs whose
// remote bytes haven't changed. Records written before sha tracking existed
// (or by the writer's own commitAddPhoto, which stores the blob before the
// PUT returns a sha) have sha=null and will be re-fetched once.
export async function storeLocal(ref, blob, sha = null) {
  // Invalidate any cached object URL for this ref — after a photo replace
  // the new blob would otherwise still render through the old URL.
  invalidateUrl(ref);
  const store = await tx(STORE_BLOBS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ ref, blob, sha });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// Update the sha on an already-stored blob without rewriting the blob itself
// or invalidating the cached object URL. Used by writer paths after the
// remote PUT returns the sha so a future syncThumbs sees local==remote and
// skips re-fetching the writer's own bytes.
export async function setLocalSha(ref, sha) {
  const store = await tx(STORE_BLOBS, 'readwrite');
  return new Promise((resolve, reject) => {
    const getReq = store.get(ref);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (!rec) { resolve(); return; }
      rec.sha = sha;
      const putReq = store.put(rec);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
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

export async function getLocalSha(ref) {
  const store = await tx(STORE_BLOBS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(ref);
    req.onsuccess = () => resolve(req.result?.sha ?? null);
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

function invalidateUrl(ref) {
  const url = _urls.get(ref);
  if (url) {
    URL.revokeObjectURL(url);
    _urls.delete(ref);
  }
}

// ─── Local cleanup ────────────────────────────────────────────────────────────
// Used by tabs/log/log.js when an entry or appendment with a `ref` is deleted.
// Failure to release the URL or remove the blob is non-fatal (the next reload
// would simply not see this ref any more).
export async function deleteLocal(ref) {
  invalidateUrl(ref);
  const store = await tx(STORE_BLOBS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(ref);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
