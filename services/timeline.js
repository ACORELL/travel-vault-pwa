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
  putFileExact, getFile, listDir,
  GitHubAuthError, GitHubNotFoundError, GitHubConflictError,
} from './github.js';
import { daysPath, getActiveSlug } from './trip-context.js';

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
  return daysPath(`${date}/timeline.json`);
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

// ─── Tombstones ───────────────────────────────────────────────────────────────
// Ids (parent or appendment) the user has optimistically deleted but whose
// remote delete atomicEdit hasn't confirmed yet. Both atomicEdit's tail
// merge and refresh.fetchDay's putCached filter these out, so a refresh
// racing the user's own delete (atomicEdit still in flight) doesn't
// resurrect the deleted entry. Cleared once atomicEdit successfully PUTs
// a state that no longer contains the id — at that point the remote
// definitely doesn't have it, and a future fetch can't bring it back.
//
// In-memory only. A full page reload mid-delete drops the tombstone; the
// queued op still drains and removes the entry properly, just with a
// brief visual flicker if the user reloaded fast enough to catch it.

const _tombstones = new Map();

export function addTombstone(date, id) {
  let set = _tombstones.get(date);
  if (!set) { set = new Set(); _tombstones.set(date, set); }
  set.add(id);
}

export function getTombstones(date) {
  return _tombstones.get(date) || new Set();
}

function clearConfirmedTombstones(date, canonicalEntries) {
  const set = _tombstones.get(date);
  if (!set || !set.size) return;
  const allIds = new Set();
  for (const e of canonicalEntries) {
    allIds.add(e.id);
    for (const a of e.appendments || []) allIds.add(a.id);
  }
  for (const id of [...set]) {
    if (!allIds.has(id)) set.delete(id);
  }
  if (!set.size) _tombstones.delete(date);
}

// ─── Pending optimistic adds ──────────────────────────────────────────────────
// Mirror of tombstones for the add direction: ids the user has optimistically
// added but whose atomicEdit hasn't confirmed on remote yet. refresh.fetchDay
// preserves these from cache when the GET response doesn't include them, so
// a refresh racing an in-flight (or queued) add doesn't briefly wipe the
// new entry. Cleared in atomicEdit's tail once the canonical PUT contains
// the id — at that point the remote has it and a future fetchDay can drop
// the cached copy if some other device has since deleted it.
//
// In-memory only. After a reload the set is empty, but the queued op (if
// any) is still in IDB — refresh.fetchDay ALSO consults ops.pendingIds()
// to cover that case. Both sources together protect both the live-race
// window (pending-adds) and the queued-add-after-reload window (ops queue).
//
// Naming: only ADDs go through here. Edits don't change ids and are
// guarded by the per-date chain serialization (refresh.fetchDay can't
// run between an edit's GET and PUT, so the cached edited copy survives).
// Deletes use tombstones.

const _pendingAdds = new Map();

export function addPendingAdd(date, id) {
  let set = _pendingAdds.get(date);
  if (!set) { set = new Set(); _pendingAdds.set(date, set); }
  set.add(id);
}

export function getPendingAdds(date) {
  return _pendingAdds.get(date) || new Set();
}

function clearConfirmedAdds(date, canonicalEntries) {
  const set = _pendingAdds.get(date);
  if (!set || !set.size) return;
  const allIds = new Set();
  for (const e of canonicalEntries) {
    allIds.add(e.id);
    for (const a of e.appendments || []) allIds.add(a.id);
  }
  for (const id of [...set]) {
    if (allIds.has(id)) set.delete(id);
  }
  if (!set.size) _pendingAdds.delete(date);
}

// ─── Per-date promise chain (intra-device mutex, D3) ──────────────────────────
// Two rapid taps on the same date can't race themselves; an add+refresh on
// the same date can't interleave the refresh's GET with the add's PUT.
// Both atomicEdit and refresh.fetchDay funnel through here. Cross-device
// races still rely on atomicEdit's sha-retry loop.

const _chains = new Map();

export function runOnDateChain(date, fn) {
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
  return runOnDateChain(date, async () => {
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
        // Merge canonical `next` with the optimistic state currently in
        // cache. Plain putCached(next, …) would wipe entries that other
        // in-flight atomicEdits in this date's chain have just added
        // optimistically — they aren't on the remote yet, so atomicEdit's
        // own getFile didn't see them. Preserve those, but DROP anything
        // the user has tombstoned (optimistic-deleted) so a racing refresh
        // can't resurrect them.
        const merged = await mergeWithCached(date, next);
        // Confirmed deletes: ids that were in `current` (the remote we
        // fetched) but are not in `next` (after the mutator removed
        // them). Their tombstones can be cleared — the remote no longer
        // has them after this PUT.
        clearConfirmedTombstones(date, next);
        // Confirmed adds: ids present in `next` are now on remote, so a
        // future fetchDay will see them and the pending-add preservation
        // is no longer needed.
        clearConfirmedAdds(date, next);
        await putCached(date, merged, newSha);
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

// Merge atomicEdit's canonical `next` with any optimistic state present in
// the local day-cache. Two cases of "preservable" cached state:
//   1. Parent entries in cache but not in next — another in-flight
//      atomicEdit added them and is still queued behind us in the chain.
//      Keep them; that atomicEdit's own tail will reconcile when it lands.
//   2. Appendments under a parent that exists in both: keep cached
//      appendments whose ids aren't in next's appendment list (same
//      reason — appendment ops chained behind us).
//
// Parents in next always win for the parent fields themselves (canonical
// edits beat the optimistic copy), but their appendment array gets merged
// with the cached copy so concurrent appendment ops don't get clobbered.
async function mergeWithCached(date, next) {
  const cached = await getCached(date);
  const cachedEntries = cached?.entries || [];
  const tombstones = getTombstones(date);

  // Strip tombstoned ids from next first — covers the case of a queued
  // op replaying an entry the user has since deleted (op queue ordering
  // can interleave with user actions), or a mutator returning state that
  // we want to mask out locally regardless.
  const stripTombstoned = list => list.map(e => {
    if (tombstones.has(e.id)) return null;
    const apps = e.appendments || [];
    if (!apps.length) return e;
    const filtered = apps.filter(a => !tombstones.has(a.id));
    return filtered.length === apps.length ? e : { ...e, appendments: filtered };
  }).filter(Boolean);

  const cleanedNext = tombstones.size ? stripTombstoned(next) : next;
  if (!cachedEntries.length) return cleanedNext;

  const cachedById = new Map(cachedEntries.map(e => [e.id, e]));
  const nextIds    = new Set(cleanedNext.map(e => e.id));

  const mergedNext = cleanedNext.map(nextParent => {
    const cachedParent = cachedById.get(nextParent.id);
    if (!cachedParent) return nextParent;
    const nextApps    = nextParent.appendments || [];
    let cachedApps    = cachedParent.appendments || [];
    if (tombstones.size) cachedApps = cachedApps.filter(a => !tombstones.has(a.id));
    if (!cachedApps.length) return nextParent;
    const nextAppIds  = new Set(nextApps.map(a => a.id));
    const preservedApps = cachedApps.filter(a => !nextAppIds.has(a.id));
    if (!preservedApps.length) return nextParent;
    return { ...nextParent, appendments: [...nextApps, ...preservedApps].sort(byT) };
  });

  let preservedParents = cachedEntries.filter(e => !nextIds.has(e.id));
  if (tombstones.size) preservedParents = preservedParents.filter(e => !tombstones.has(e.id));
  if (!preservedParents.length) return mergedNext.sort(byT);
  return [...mergedNext, ...preservedParents].sort(byT);
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
    return rewriteOrphanedGroupRefs(xs.filter(e => e.id !== id));
  });
}

// Anchor-deletion rewrite (Phase 2 — plans/GROUPING-PLAN.md §2 "Anchor
// deletion"). After any deletion, scan survivors for groupId values that
// point at a now-deleted entry; re-anchor each such orphaned group by
// promoting the earliest-by-t surviving member. Generic over single and
// batch deletes (deleteEntry, deleteMany). Members whose anchor was NOT
// deleted are untouched — their groupId still resolves cleanly.
function rewriteOrphanedGroupRefs(entries) {
  const ids = new Set(entries.map(e => e.id));
  const orphans = new Set();
  for (const e of entries) {
    if (e.groupId && !ids.has(e.groupId)) orphans.add(e.groupId);
  }
  if (!orphans.size) return entries;
  const newAnchorByOldId = new Map();
  for (const oldAnchor of orphans) {
    const survivors = entries.filter(e => e.groupId === oldAnchor);
    if (!survivors.length) continue;       // singleton anchor, no members
    survivors.sort(byT);
    newAnchorByOldId.set(oldAnchor, survivors[0].id);
  }
  if (!newAnchorByOldId.size) return entries;
  return entries.map(e => {
    if (!e.groupId || !newAnchorByOldId.has(e.groupId)) return e;
    return { ...e, groupId: newAnchorByOldId.get(e.groupId) };
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
    return rewriteOrphanedGroupRefs(xs.filter(e => !ids.has(e.id)));
  });
}

// ─── Day index ────────────────────────────────────────────────────────────────
// Today is always included even when the data repo has no folder for it yet,
// so the day-nav shows it as a target before the first capture lands.

export async function listAvailableDates() {
  const today = new Date().toISOString().slice(0, 10);
  let remote = [];
  try {
    const items = await listDir(`${getActiveSlug()}/days`);
    remote = items
      .filter(i => i.type === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(i.name))
      .map(i => i.name);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    remote = [];
  }
  return Array.from(new Set([today, ...remote])).sort().reverse();
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
