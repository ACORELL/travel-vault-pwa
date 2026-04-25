// Settings overlay — four inputs, Test connection, Clear PAT, Reset all.
// Reads/writes via services/settings.js. Tests connectivity via services/github.js.
// Owns the #settings-overlay markup in index.html.

import * as settings from '../services/settings.js';
import { GITHUB_PAT, GITHUB_REPO, WORKER_URL, AUTHOR } from '../services/settings.js';
import { getFile, GitHubAuthError, GitHubNotFoundError } from '../services/github.js';
import * as queue from '../services/queue.js';

const DEFAULT_WORKER_URL = 'https://travel-vault-worker.corell-ask.workers.dev';

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
  $('settings-worker').value = settings.get(WORKER_URL)  || DEFAULT_WORKER_URL;
  $('settings-author').value = settings.get(AUTHOR)      || '';
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
  settings.set(WORKER_URL,  $('settings-worker').value.trim());
  const author = $('settings-author').value.trim().toUpperCase();
  if (author === 'N' || author === 'A') settings.set(AUTHOR, author);
}

async function testConnection() {
  saveInputs();
  setStatus('Testing…', '');
  try {
    await getFile('trip.md');
    setStatus('Connected ✓', 'ok');
    window.dispatchEvent(new CustomEvent('sync-status', { detail: 'synced' }));
    window.dispatchEvent(new CustomEvent('try-flush'));
  } catch (e) {
    if (e instanceof GitHubAuthError) {
      setStatus('Auth failed — check PAT and repo', 'error');
      window.dispatchEvent(new CustomEvent('sync-status', { detail: 'offline' }));
    } else if (e instanceof GitHubNotFoundError) {
      // Auth succeeded — repo is reachable; trip.md just isn't there.
      setStatus('Connected, but trip.md not found in repo', 'error');
      window.dispatchEvent(new CustomEvent('sync-status', { detail: 'synced' }));
      window.dispatchEvent(new CustomEvent('try-flush'));
    } else {
      setStatus('Network error — check Worker URL or connectivity', 'error');
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
  if (!confirm('Wipe all settings (PAT, repo, worker URL, author)? Queue will also be cleared.')) return;
  settings.reset();
  await queue.clear();
  populateInputs();
  setStatus('All settings wiped', 'ok');
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
  $('settings-clear').addEventListener('click', clearCredentials);
  $('settings-reset-all').addEventListener('click', resetAll);
}
