// Local-first timeline of capture entries (checkin / note / photo) per day per author.
//
// Each device owns days/YYYY-MM-DD/timelines/<author>.json in the data repo.
// Capture writes here go to IDB instantly; services/sync.js publishes the day's
// entries as a full-file PUT. Cross-device read fetches the *other* author's
// JSON and caches it locally.
//
// Schema lives in this module (per pwa-structure.md "services own all I/O" rule).

import { get, AUTHOR } from './settings.js';
import { getFile, listDir, GitHubAuthError, GitHubNotFoundError } from './github.js';

const DB_NAME     = 'tv-timeline';
const STORE_OWN   = 'timeline-local';
const STORE_OTHER = 'timeline-cache';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      // Compound key by (date, author, id) — lets getOwn(date) range-scan
      // without filtering, and ids stay short ('HHMMSS_<author>').
      if (!db.objectStoreNames.contains(STORE_OWN)) {
        db.createObjectStore(STORE_OWN, { keyPath: ['date', 'author', 'id'] });
      }
      if (!db.objectStoreNames.contains(STORE_OTHER)) {
        db.createObjectStore(STORE_OTHER, { keyPath: ['date', 'author'] });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(store, mode) {
  return open().then(db => db.transaction(store, mode).objectStore(store));
}

function selfAuthor() {
  const a = get(AUTHOR);
  if (a !== 'N' && a !== 'A') throw new Error(`Author not set (got ${a})`);
  return a;
}

// Strip the IDB-only metadata before returning entries to callers.
function stripMeta({ date, author, ...rest }) { return rest; }

// ─── Append local entry ───────────────────────────────────────────────────────
// entry shape per PHASE4.md §4:
//   { id, type: 'checkin'|'note'|'photo', t, gps?, content?, ref?, comment? }
// `id` already encodes the author (`HHMMSS_<author>`). We still tag the row
// with date+author for the keyPath — date is not part of the on-disk schema.
export async function appendLocal(date, entry) {
  const author = selfAuthor();
  const store  = await tx(STORE_OWN, 'readwrite');
  await new Promise((resolve, reject) => {
    const req = store.put({ date, author, ...entry });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  window.dispatchEvent(new CustomEvent('timeline-changed', { detail: { date, author } }));
}

// ─── Read own entries for a date ──────────────────────────────────────────────
export async function getOwn(date) {
  const author = selfAuthor();
  const store  = await tx(STORE_OWN, 'readonly');
  const range  = IDBKeyRange.bound([date, author, ''], [date, author, '￿']);
  return new Promise((resolve, reject) => {
    const items = [];
    store.openCursor(range).onsuccess = e => {
      const cur = e.target.result;
      if (cur) { items.push(stripMeta(cur.value)); cur.continue(); }
      else resolve(items.sort((a, b) => (a.t || '').localeCompare(b.t || '')));
    };
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

// ─── Fetch the other author's timeline for a date ─────────────────────────────
// Online: GET timelines/<author>.json, cache result. 404 caches []. Network
// failure falls back to last cached value. Auth errors rethrow so the caller
// can redirect to settings.
export async function getOther(date, otherAuthor) {
  const path = `days/${date}/timelines/${otherAuthor}.json`;
  try {
    const { content } = await getFile(path);
    let entries;
    try { entries = JSON.parse(content); } catch { entries = []; }
    await cachePut(date, otherAuthor, entries);
    return entries;
  } catch (e) {
    if (e instanceof GitHubNotFoundError) {
      await cachePut(date, otherAuthor, []);
      return [];
    }
    if (e instanceof GitHubAuthError) throw e;
    return cacheGet(date, otherAuthor);
  }
}

async function cachePut(date, author, entries) {
  const store = await tx(STORE_OTHER, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ date, author, entries, fetchedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function cacheGet(date, author) {
  const store = await tx(STORE_OTHER, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get([date, author]);
    req.onsuccess = () => resolve(req.result?.entries || []);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Combined view: own ∪ other authors, sorted by t ──────────────────────────
// Each returned entry carries `author` so the renderer can branch (own → local
// thumbnail; other → placeholder) without re-querying settings.
export async function getCombined(date) {
  const self   = selfAuthor();
  const others = self === 'N' ? ['A'] : ['N'];
  const ownPromise = getOwn(date).then(es => es.map(e => ({ ...e, author: self })));
  const otherPromises = others.map(a =>
    getOther(date, a).then(es => es.map(e => ({ ...e, author: a })))
  );
  const buckets = await Promise.all([ownPromise, ...otherPromises]);
  return buckets.flat().sort((a, b) => (a.t || '').localeCompare(b.t || ''));
}

// ─── List of dates with data (for day navigation) ─────────────────────────────
// Today is always included even when the data repo has no folder for it yet.
export async function listAvailableDates() {
  const today = new Date().toISOString().slice(0, 10);
  let remote = [];
  try {
    const items = await listDir('days');
    remote = items
      .filter(i => i.type === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(i.name))
      .map(i => i.name);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    remote = [];
  }
  return Array.from(new Set([today, ...remote])).sort().reverse();
}

// ─── Reset (used by the existing "Reset app" path) ────────────────────────────
export async function clearLocal() {
  const store = await tx(STORE_OWN, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
