// Per-client active-trip state for the phone. Slug is persisted in
// localStorage as `tv-phone-active-trip` (default `test`); every repo path
// the phone touches gets prefixed with the slug. The trips list is read
// lazily from the data repo's `_trips.json` (laptop owns CRUD; phone is
// read-only on the trip lifecycle, but can switch which trip is active).
//
// Public surface (deep module, simple interface):
//   getActiveSlug()         → string
//   setActiveSlug(slug)     → void; also bumps SW cache key on next reload
//   wikiPath(rest)          → "<slug>/wiki/<rest>"
//   daysPath(rest)          → "<slug>/days/<rest>"
//   tripMdPath()            → "<slug>/trip.md"
//   trips()                 → Promise<[ { slug, name, accent_color, archived } ]>
//                             (cached for 30s; force=true to refresh)

import { getFile } from './github.js';

const STORAGE_KEY = 'tv-phone-active-trip';
const DEFAULT_SLUG = 'test';
const TRIPS_INDEX_PATH = '_trips.json';
const TRIPS_TTL_MS = 30 * 1000;

let _tripsCache = null; // { ts, items }

export function getActiveSlug() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_SLUG;
  } catch {
    return DEFAULT_SLUG;
  }
}

export function setActiveSlug(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('setActiveSlug: slug required');
  try { localStorage.setItem(STORAGE_KEY, slug); }
  catch (err) { console.error('[trip-context] setActiveSlug write failed:', err.message); }
  // Drop any stale trips cache so the next read sees the freshest list.
  _tripsCache = null;
  // Notify other modules so they can react (e.g. clear in-memory caches).
  window.dispatchEvent(new CustomEvent('trip-changed', { detail: { slug } }));
}

export function wikiPath(rest) {
  return `${getActiveSlug()}/wiki/${rest}`;
}

export function daysPath(rest) {
  return `${getActiveSlug()}/days/${rest}`;
}

export function tripMdPath() {
  return `${getActiveSlug()}/trip.md`;
}

export async function trips({ force = false } = {}) {
  if (!force && _tripsCache && Date.now() - _tripsCache.ts < TRIPS_TTL_MS) {
    return _tripsCache.items;
  }
  try {
    const got = await getFile(TRIPS_INDEX_PATH);
    const idx = JSON.parse(got.content);
    const items = Array.isArray(idx.trips) ? idx.trips : [];
    _tripsCache = { ts: Date.now(), items };
    return items;
  } catch (err) {
    console.error('[trip-context] trips() fetch failed:', err.message);
    return [];
  }
}
