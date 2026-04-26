// Shared per-day timeline (Phase 5).
//
// One file per day in the data repo: days/YYYY-MM-DD/timeline.json. Both
// authors read-and-write it directly. atomicEdit fetches sha → runs mutator
// → PUTs with sha; on 422 it refetches and re-runs the mutator on the fresh
// content, so cross-device adds/edits/deletes don't stomp each other (D2).
// A per-date in-memory promise chain prevents intra-device self-races (D3).
//
// Local IDB store `tv-timeline / day-cache` is a cache of remote: keyed by
// date, value `{ entries, sha, fetchedAt }`. Reads (services/refresh.js) and
// writes (atomicEdit's tail) both go through it so the renderer always reads
// the latest known state.

import {
  putFileExact, getFile,
  GitHubAuthError, GitHubNotFoundError, GitHubConflictError,
} from './github.js';

const DB_NAME    = 'tv-timeline';
const DB_VERSION = 2;
const STORE      = 'day-cache';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      // Phase 4 stores are dropped — hard cutover (PHASE5.md §11).
      for (const name of ['timeline-local', 'timeline-cache']) {
        if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'date' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(mode) {
  return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function pathFor(date) {
  return `days/${date}/timeline.json`;
}

function byT(a, b) {
  return (a.t || '').localeCompare(b.t || '');
}

function emitDayChanged(date) {
  window.dispatchEvent(new CustomEvent('day-changed', { detail: { date } }));
}

// ─── Day-cache read / write ───────────────────────────────────────────────────
// Exposed so refresh.js can populate the cache from a fresh remote fetch
// without going through atomicEdit (no mutation, just sync).

export async function getCached(date) {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(date);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

export async function putCached(date, entries, sha) {
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.put({ date, entries, sha, fetchedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  emitDayChanged(date);
}

// ─── ID generation ────────────────────────────────────────────────────────────
// `HHMMSS_<author>` from t's *local* time. Same-second/same-author bursts
// (rare) get a `_<n>` suffix.

export function makeId(t, author, existingEntries = []) {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const base = `${hh}${mm}${ss}_${author}`;
  const taken = new Set();
  for (const e of existingEntries) {
    taken.add(e.id);
    for (const a of e.appendments || []) taken.add(a.id);
  }
  if (!taken.has(base)) return base;
  for (let n = 1; n < 100; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('makeId: too many collisions');
}

// ─── Per-date promise chain (intra-device mutex, D3) ──────────────────────────
// Two rapid taps on the same date can't race themselves. Cross-device races
// rely on atomicEdit's sha-retry loop.

const _chains = new Map();

function chain(date, fn) {
  const last = _chains.get(date) || Promise.resolve();
  const next = last.catch(() => {}).then(fn);
  _chains.set(date, next);
  next.finally(() => { if (_chains.get(date) === next) _chains.delete(date); });
  return next;
}

// ─── atomicEdit ───────────────────────────────────────────────────────────────
// Fetch current content + sha → run mutator → PUT with sha. On conflict,
// refetch and re-run the mutator once on the fresh content. The mutator must
// be safe to run twice — its closure-captured `refSink` (if any) is expected
// to clear itself at the start of each call.

export async function atomicEdit(date, mutator) {
  return chain(date, async () => {
    const path = pathFor(date);
    let lastConflict;
    for (let attempt = 0; attempt < 2; attempt++) {
      let current = [];
      let sha;
      try {
        const fetched = await getFile(path);
        sha = fetched.sha;
        try { current = JSON.parse(fetched.content); } catch { current = []; }
        if (!Array.isArray(current)) current = [];
      } catch (e) {
        if (e instanceof GitHubNotFoundError) { current = []; sha = undefined; }
        else throw e;
      }
      const next = mutator(current);
      try {
        const { sha: newSha } = await putFileExact(
          path,
          JSON.stringify(next, null, 2),
          `Update ${date} timeline`,
          sha,
        );
        await putCached(date, next, newSha);
        return next;
      } catch (e) {
        if (e instanceof GitHubAuthError) throw e;
        if (e instanceof GitHubConflictError) { lastConflict = e; continue; }
        throw e;
      }
    }
    throw lastConflict || new GitHubConflictError(`atomicEdit gave up on ${pathFor(date)}`);
  });
}

// ─── Mutators (named exports — see PHASE5.md §5) ──────────────────────────────
// Each closure-captured `refSink` is cleared at the start of every mutator
// call so a retry doesn't double-up the cleanup list.

export function addEntry(date, entry) {
  return atomicEdit(date, xs => [...xs, entry].sort(byT));
}

export function editEntry(date, id, patch) {
  return atomicEdit(date, xs =>
    xs.map(e => e.id === id ? { ...e, ...patch } : e),
  );
}

export function deleteEntry(date, id, refSink = []) {
  return atomicEdit(date, xs => {
    refSink.length = 0;
    const target = xs.find(e => e.id === id);
    if (target) {
      if (target.ref) refSink.push(target.ref);
      for (const a of target.appendments || []) {
        if (a.ref) refSink.push(a.ref);
      }
    }
    return xs.filter(e => e.id !== id);
  });
}

export function addAppendment(date, parentId, appendment) {
  return atomicEdit(date, xs =>
    xs.map(e => e.id === parentId
      ? { ...e, appendments: [...(e.appendments || []), appendment].sort(byT) }
      : e,
    ),
  );
}

export function editAppendment(date, parentId, appId, patch) {
  return atomicEdit(date, xs =>
    xs.map(e => {
      if (e.id !== parentId) return e;
      const apps = (e.appendments || []).map(a =>
        a.id === appId ? { ...a, ...patch } : a,
      );
      return { ...e, appendments: apps };
    }),
  );
}

export function deleteAppendment(date, parentId, appId, refSink = []) {
  return atomicEdit(date, xs => {
    refSink.length = 0;
    return xs.map(e => {
      if (e.id !== parentId) return e;
      const apps = e.appendments || [];
      const target = apps.find(a => a.id === appId);
      if (target?.ref) refSink.push(target.ref);
      return { ...e, appendments: apps.filter(a => a.id !== appId) };
    });
  });
}

export function deleteMany(date, idsToRemove, refSink = []) {
  const ids = new Set(idsToRemove);
  return atomicEdit(date, xs => {
    refSink.length = 0;
    for (const e of xs) {
      if (!ids.has(e.id)) continue;
      if (e.ref) refSink.push(e.ref);
      for (const a of e.appendments || []) {
        if (a.ref) refSink.push(a.ref);
      }
    }
    return xs.filter(e => !ids.has(e.id));
  });
}

// ─── Reset (used by the "Reset app" path) ─────────────────────────────────────

export async function clearLocal() {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}
