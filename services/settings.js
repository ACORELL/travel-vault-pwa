// localStorage read/write — single source of truth for all PWA config.
// No other file calls localStorage directly.

export const GITHUB_PAT  = 'tv-github-pat';
export const GITHUB_REPO = 'tv-github-repo';
export const WORKER_URL  = 'tv-worker-url';
export const AUTHOR      = 'tv-author';

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
  localStorage.removeItem(WORKER_URL);
  localStorage.removeItem(AUTHOR);
}
