// localStorage read/write — single source of truth for all PWA config.
// No other file calls localStorage directly.

export const GITHUB_PAT       = 'tv-github-pat';
export const GITHUB_REPO      = 'tv-github-repo';
export const AUTHOR           = 'tv-author';
export const GROUP_WINDOW_MIN = 'tv-group-window-min';

// Active-anchor stale window for capture-time grouping (Phase 2 —
// plans/GROUPING-PLAN.md §3). Default 10 min; clamped to 1..240 so a
// hand-set garbage value can't lock the active anchor open all day.
const GROUP_WINDOW_DEFAULT = 10;
const GROUP_WINDOW_MAX     = 240;
export function getGroupWindowMinutes() {
  const raw = localStorage.getItem(GROUP_WINDOW_MIN);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return GROUP_WINDOW_DEFAULT;
  if (n > GROUP_WINDOW_MAX) return GROUP_WINDOW_MAX;
  return n;
}

const LEGACY_AUTHOR_KEY = 'tv-author';

// Run once on module load: migrate the legacy tv-author key.
// Old code wrote 'tv-author' directly. AUTHOR resolves to the same string,
// so this is a no-op on existing installs but keeps the contract explicit:
// settings.js owns every key.
(function migrate() {
  if (LEGACY_AUTHOR_KEY === AUTHOR) return;
  const legacy = localStorage.getItem(LEGACY_AUTHOR_KEY);
  if (legacy && !localStorage.getItem(AUTHOR)) {
    localStorage.setItem(AUTHOR, legacy);
    localStorage.removeItem(LEGACY_AUTHOR_KEY);
  }
})();

export function get(key) {
  return localStorage.getItem(key);
}

export function set(key, value) {
  if (value == null || value === '') localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

// Wipe sensitive credentials but keep author + repo so the user doesn't have
// to re-enter everything after a token rotation.
export function clear() {
  localStorage.removeItem(GITHUB_PAT);
}

// Full wipe — used by the existing "Reset app" path.
export function reset() {
  localStorage.removeItem(GITHUB_PAT);
  localStorage.removeItem(GITHUB_REPO);
  localStorage.removeItem(AUTHOR);
}
