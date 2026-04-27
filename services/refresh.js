// Pull-based refresh of the shared timeline (Phase 5).
//
// Reads days/<date>/timeline.json from the data repo, hydrates timeline.js's
// day-cache, and emits 'day-changed' (via putCached) so the UI re-renders.
// Per-date throttle keeps quick foreground/online ticks from hammering the
// GitHub API.
//
// Triggered by: app boot, visibilitychange→visible, 'online', the manual
// Refresh button, and day-nav (prev/next). Manual Refresh passes
// `{ force: true }` to bypass the throttle.
//
// The actual fetch+cache work runs through timeline.runOnDateChain, the
// same per-date mutex atomicEdit uses. That prevents a refresh's GET from
// racing an in-flight write's PUT (the bug where add-then-refresh briefly
// wiped the new entry until atomicEdit's tail merged it back in).
// Pending-add preservation (getPendingAdds + ops.pendingIds) covers the
// remaining cases: a fetch landing while an add is queued offline, or
// after a reload where the in-memory pending-adds set is empty but the
// op is still in IDB.

import { getFile, GitHubAuthError, GitHubNotFoundError } from './github.js';
import {
  getCached, putCached,
  getTombstones, getPendingAdds, runOnDateChain,
} from './timeline.js';
import * as ops from './ops.js';

const THROTTLE_MS = 10_000;

const _lastFetched = new Map();

function pathFor(date) {
  return `days/${date}/timeline.json`;
}

function byT(a, b) {
  return (a.t || '').localeCompare(b.t || '');
}

export function isAutoRefreshDue(date) {
  const last = _lastFetched.get(date) || 0;
  return Date.now() - last >= THROTTLE_MS;
}

// ISO timestamp of the most recent successful fetch *or* mutation for a
// given date — both go through timeline.putCached so the UI can show one
// "last refreshed" indicator without distinguishing the source.
export async function lastRefreshedAt(date) {
  const cached = await getCached(date);
  return cached?.fetchedAt ? new Date(cached.fetchedAt).toISOString() : null;
}

// Drop tombstoned (optimistically deleted) ids from a remote-fetched list.
// Without this, a refresh racing a delete would re-fetch the still-present
// remote entry and resurrect it locally.
function stripTombstones(entries, tombstones) {
  return entries
    .filter(e => !tombstones.has(e.id))
    .map(e => {
      const apps = e.appendments || [];
      if (!apps.length) return e;
      const filtered = apps.filter(a => !tombstones.has(a.id));
      return filtered.length === apps.length ? e : { ...e, appendments: filtered };
    });
}

// Re-add (or re-fold) ids the user has optimistically added but whose
// atomicEdit hasn't confirmed on remote yet. Mirrors stripTombstones for
// the add direction. Without this, a refresh that races a fresh add (or
// runs while the add is queued offline) would briefly wipe the entry
// from cache between the GET and atomicEdit's PUT landing.
function preserveOptimisticAdds(remote, cached, pendingAdds) {
  if (!pendingAdds.size || !cached.length) return remote;
  const remoteIds = new Set(remote.map(e => e.id));

  // Step 1: For parents present in both, fold in cached appendments whose
  // ids are pending-add and not yet on remote.
  const merged = remote.map(re => {
    const ce = cached.find(e => e.id === re.id);
    if (!ce) return re;
    const cachedApps = ce.appendments || [];
    if (!cachedApps.length) return re;
    const remoteApps = re.appendments || [];
    const remoteAppIds = new Set(remoteApps.map(a => a.id));
    const preserveApps = cachedApps.filter(a => !remoteAppIds.has(a.id) && pendingAdds.has(a.id));
    if (!preserveApps.length) return re;
    return { ...re, appendments: [...remoteApps, ...preserveApps].sort(byT) };
  });

  // Step 2: Cached parents not in remote, but in pending-adds — add as new
  // entries on top of the remote list.
  const preserveParents = cached.filter(e => !remoteIds.has(e.id) && pendingAdds.has(e.id));
  if (!preserveParents.length) return merged;
  return [...merged, ...preserveParents].sort(byT);
}

// Fetches days/<date>/timeline.json, caches it, returns the entries array.
// 404 caches []. Auth errors propagate so the caller can redirect to
// settings. Other network errors fall back to the existing cached value.
export async function fetchDay(date, { force = false } = {}) {
  if (!force && !isAutoRefreshDue(date)) {
    const cached = await getCached(date);
    return cached?.entries || [];
  }
  // Stamp _lastFetched outside the chain so two parallel fetchDay calls in
  // the same task don't both pass the throttle check and both queue work.
  _lastFetched.set(date, Date.now());
  return runOnDateChain(date, async () => {
    try {
      const { content, sha } = await getFile(pathFor(date));
      let entries;
      try { entries = JSON.parse(content); } catch { entries = []; }
      if (!Array.isArray(entries)) entries = [];

      const tombstones = getTombstones(date);
      if (tombstones.size) entries = stripTombstones(entries, tombstones);

      // Union the in-memory pending-adds (live races) with ids referenced
      // by queued ops (covers reload-with-queued-add).
      const pendingAdds = getPendingAdds(date);
      let allPending = pendingAdds;
      try {
        const opIds = await ops.pendingIds();
        if (opIds.size) {
          allPending = new Set([...pendingAdds, ...opIds]);
        }
      } catch { /* ignore — fall back to in-memory only */ }

      if (allPending.size) {
        const cached = await getCached(date);
        if (cached?.entries?.length) {
          entries = preserveOptimisticAdds(entries, cached.entries, allPending);
        }
      }

      await putCached(date, entries, sha);
      return entries;
    } catch (e) {
      if (e instanceof GitHubNotFoundError) {
        await putCached(date, [], undefined);
        return [];
      }
      if (e instanceof GitHubAuthError) throw e;
      const cached = await getCached(date);
      return cached?.entries || [];
    }
  });
}

// Opportunistic refresh for visibility/online triggers. Returns the entries
// when a fetch ran, null when throttled. The UI button uses fetchDay with
// `{ force: true }` instead.
export async function maybeRefresh(date) {
  if (!isAutoRefreshDue(date)) return null;
  return fetchDay(date);
}
