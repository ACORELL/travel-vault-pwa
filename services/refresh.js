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

import { getFile, GitHubAuthError, GitHubNotFoundError } from './github.js';
import { getCached, putCached } from './timeline.js';

const THROTTLE_MS = 10_000;

const _lastFetched = new Map();

function pathFor(date) {
  return `days/${date}/timeline.json`;
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

// Fetches days/<date>/timeline.json, caches it, returns the entries array.
// 404 caches []. Auth errors propagate so the caller can redirect to
// settings. Other network errors fall back to the existing cached value.
export async function fetchDay(date, { force = false } = {}) {
  if (!force && !isAutoRefreshDue(date)) {
    const cached = await getCached(date);
    return cached?.entries || [];
  }
  _lastFetched.set(date, Date.now());
  try {
    const { content, sha } = await getFile(pathFor(date));
    let entries;
    try { entries = JSON.parse(content); } catch { entries = []; }
    if (!Array.isArray(entries)) entries = [];
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
}

// Opportunistic refresh for visibility/online triggers. Returns the entries
// when a fetch ran, null when throttled. The UI button uses fetchDay with
// `{ force: true }` instead.
export async function maybeRefresh(date) {
  if (!isAutoRefreshDue(date)) return null;
  return fetchDay(date);
}
