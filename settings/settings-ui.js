// Settings overlay — three inputs, Test connection, Clear PAT, Reset all.
// Reads/writes via services/settings.js. Tests connectivity via services/github.js.
// Owns the #settings-overlay markup in index.html.

import * as settings from '../services/settings.js';
import { GITHUB_PAT, GITHUB_REPO, AUTHOR } from '../services/settings.js';
import { getFile, GitHubAuthError, GitHubNotFoundError } from '../services/github.js';
import * as queue from '../services/queue.js';
import { restoreFromRepo } from '../services/restore.js';
import * as tripCtx from '../services/trip-context.js';

let _opened = false;

export function openSettings() {
  populateInputs();
  setStatus('', '');
  document.getElementById('settings-overlay').classList.remove('hidden');
  _opened = true;
}

export function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
  _opened = false;
}

export function isOpen() { return _opened; }

function $(id) { return document.getElementById(id); }

function populateInputs() {
  $('settings-pat').value    = settings.get(GITHUB_PAT)  || '';
  $('settings-repo').value   = settings.get(GITHUB_REPO) || '';
  $('settings-author').value = settings.get(AUTHOR)      || '';
  populateTripSelect();
}

async function populateTripSelect() {
  const sel = $('settings-trip');
  if (!sel) return;
  const active = tripCtx.getActiveSlug();
  // Render an immediate single-option fallback so the active slug is at least
  // visible if the data-repo round-trip is slow / offline.
  sel.innerHTML = `<option value="${active}">${active}</option>`;
  try {
    const trips = await tripCtx.trips();
    if (!trips.length) return;
    sel.innerHTML = trips.map(t => {
      const label = `${t.name || t.slug}${t.archived ? ' (archived)' : ''}`;
      return `<option value="${t.slug}"${t.slug === active ? ' selected' : ''}>${label}</option>`;
    }).join('');
  } catch (err) {
    console.error('[settings-ui] trip list fetch failed:', err.message);
  }
}

function setStatus(msg, kind) {
  const el = $('settings-status');
  el.textContent = msg;
  el.className = 'settings-status' + (kind ? ` settings-status-${kind}` : '');
  el.style.display = msg ? 'block' : 'none';
}

function saveInputs() {
  settings.set(GITHUB_PAT,  $('settings-pat').value.trim());
  settings.set(GITHUB_REPO, $('settings-repo').value.trim());
  const author = $('settings-author').value.trim().toUpperCase();
  if (author === 'N' || author === 'A') settings.set(AUTHOR, author);
  // Trip selector — switch active slug if it changed. setActiveSlug emits
  // 'trip-changed' which downstream listeners can use to clear caches.
  const sel = $('settings-trip');
  if (sel && sel.value && sel.value !== tripCtx.getActiveSlug()) {
    tripCtx.setActiveSlug(sel.value);
  }
}

async function testConnection() {
  saveInputs();
  setStatus('Testing…', '');
  try {
    await getFile(tripCtx.tripMdPath());
    setStatus('Connected ✓', 'ok');
    window.dispatchEvent(new CustomEvent('sync-status', { detail: 'synced' }));
    window.dispatchEvent(new CustomEvent('try-flush'));
  } catch (e) {
    if (e instanceof GitHubAuthError) {
      setStatus('Auth failed — check PAT and repo', 'error');
      window.dispatchEvent(new CustomEvent('sync-status', { detail: 'offline' }));
    } else if (e instanceof GitHubNotFoundError) {
      // Auth succeeded — repo is reachable; the active trip's trip.md just
      // isn't there. Common when a fresh trip slug was selected before the
      // listener pushed it.
      setStatus(`Connected, but ${tripCtx.tripMdPath()} not found in repo`, 'error');
      window.dispatchEvent(new CustomEvent('sync-status', { detail: 'synced' }));
      window.dispatchEvent(new CustomEvent('try-flush'));
    } else {
      const kind = (e && e.constructor && e.constructor.name) || typeof e;
      const msg  = (e && e.message) || String(e);
      const online = navigator.onLine ? 'on' : 'off';
      setStatus(`v48 fail [${kind}] ${msg} | net=${online}`, 'error');
      window.dispatchEvent(new CustomEvent('sync-status', { detail: 'offline' }));
    }
  }
}

async function clearCredentials() {
  if (!confirm('Clear stored GitHub PAT and offline queue?')) return;
  settings.clear();
  await queue.clear();
  populateInputs();
  setStatus('Credentials and queue cleared', 'ok');
}

async function resetAll() {
  if (!confirm('Wipe all settings (PAT, repo, author)? Queue will also be cleared.')) return;
  settings.reset();
  await queue.clear();
  populateInputs();
  setStatus('All settings wiped', 'ok');
}

async function restore() {
  saveInputs();
  if (!settings.get(GITHUB_PAT) || !settings.get(GITHUB_REPO) || !settings.get(AUTHOR)) {
    setStatus('PAT, repo, and author are required', 'error');
    return;
  }
  if (!confirm('Restore your own timeline + thumbnails from the data repo? Existing local entries with the same id are overwritten.')) return;
  setStatus('Restoring…', '');
  try {
    const result = await restoreFromRepo(p => {
      if (p.phase === 'thumb' || p.phase === 'date-entries-done') {
        setStatus(`Restoring… ${p.entries} entries, ${p.thumbs} thumbs`, '');
      }
    });
    setStatus(`Restored ${result.entries} entries and ${result.thumbs} thumbs across ${result.dates} day(s)`, 'ok');
    window.dispatchEvent(new CustomEvent('timeline-restored'));
  } catch (e) {
    if (e instanceof GitHubAuthError) {
      setStatus('Auth failed — check PAT and repo', 'error');
    } else {
      setStatus(`Restore failed: ${e.message}`, 'error');
    }
  }
}

export function init() {
  $('header-settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => { saveInputs(); closeSettings(); });
  $('settings-save').addEventListener('click',  () => {
    saveInputs();
    setStatus('Saved ✓', 'ok');
    // If the user just fixed their PAT, drain whatever is parked.
    window.dispatchEvent(new CustomEvent('try-flush'));
  });
  $('settings-test').addEventListener('click', testConnection);
  $('settings-restore').addEventListener('click', restore);
  $('settings-clear').addEventListener('click', clearCredentials);
  $('settings-reset-all').addEventListener('click', resetAll);
}
