import { saveVaultHandle, getVaultHandle } from './db.js';
import * as vault from './vault.js';
import * as settingsUi from './settings/settings-ui.js';
import { loadWiki } from './tabs/wiki/wiki.js';
import * as queue from './services/queue.js';
import * as settings from './services/settings.js';
import { GITHUB_PAT, GITHUB_REPO } from './services/settings.js';
import { $, $$, show, hide, fmtDate, hideBanner, setSyncStatus } from './core/ui.js';
import { s, TODAY } from './core/state.js';
import * as geoloc from './services/location.js';
import * as wikiUi from './tabs/wiki/wiki-ui.js';
import * as todayStrip from './tabs/wiki/today-strip.js';
import * as captureUi from './tabs/capture/capture-ui.js';
import * as logTab from './tabs/log/log.js';
import { setupTabs } from './core/router.js';

// ---- Boot ----
const VERSION = 35; // bump in lockstep with sw.js CACHE on every push
const FSA_SUPPORTED = typeof window.showDirectoryPicker === 'function';

// Stamp the version into the bottom-right of the app shell at module load.
// Visible on every screen for at-a-glance "did the new build land?" debugging.
{
  const el = document.getElementById('app-version');
  if (el) el.textContent = 'v' + VERSION;
}

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=' + VERSION).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
  if (navigator.storage?.persist) {
    navigator.storage.persist().then(granted => {
      console.log('[TV] storage.persist granted:', granted);
      if (!granted) console.warn('[TV] IndexedDB may be evicted under storage pressure — vault handle could be lost on cold start.');
    }).catch(() => {});
  }

  // Step 1: author selection — first launch only
  if (!s.author) {
    show('setup-overlay');
    $$('.author-btn').forEach(btn => btn.addEventListener('click', async () => {
      s.author = btn.dataset.initial;
      localStorage.setItem('tv-author', s.author);
      hide('setup-overlay');
      await bootApp();
    }));
    return;
  }

  // Author known — ensure overlay is hidden and boot the app.
  hide('setup-overlay');
  await bootApp();
}

// Always show the app shell. Vault folder is optional — captures and settings
// work without it. Log/photos/wiki tabs degrade gracefully when no vault.
async function bootApp() {
  let saved = null;
  try { saved = await getVaultHandle(); } catch {}
  show('app');
  startApp(saved);
}

// Best-effort drain of the offline queue. Called from: boot, 'online' event,
// settings save, settings test pass, and after any successful capture PUT.
// All gates are inside this function so callers can fire it blindly.
async function tryFlush() {
  if (!settings.get(GITHUB_PAT) || !settings.get(GITHUB_REPO)) return;
  if (!navigator.onLine) return;
  try {
    if ((await queue.count()) === 0) return;
  } catch { return; }
  setSyncStatus('syncing');
  try {
    const { failed } = await queue.flush();
    setSyncStatus(failed === 0 ? 'synced' : 'offline');
  } catch {
    setSyncStatus('offline');
  }
}

// Settings dispatches this after Save and after Test connection passes.
window.addEventListener('try-flush', tryFlush);

async function resetApp() {
  localStorage.clear();
  try { indexedDB.deleteDatabase('travel-vault'); } catch {}
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map(r => r.unregister()));
  }
  window.location.reload();
}

// First-time vault folder selection — opened from the vault-banner button
// (only when FSA is supported).
$('pick-vault-btn').addEventListener('click', async () => {
  try {
    const handle = await vault.pickVaultFolder();
    if (!await vault.isVaultRoot(handle)) {
      $('vault-setup-error').textContent = 'Wrong folder — please select the Travel Vault root (it contains trip.md).';
      return;
    }
    await saveVaultHandle(handle);
    hide('vault-setup-overlay');
    await activateVault(handle);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Vault picker error:', e);
      $('vault-setup-error').textContent = e.message || 'Could not access folder — please try again.';
    }
  }
});

// Connects an already-picked-and-permissioned vault handle to the running app
// without re-binding listeners. Used by both the first-time picker and the
// reconnect flow.
async function activateVault(handle) {
  s.vault = handle;
  hideBanner('vault-banner');
  setSyncStatus('syncing');
  try {
    await logTab.syncQueue();
    await logTab.loadAvailableDays();
    await logTab.loadLog();
    await loadWiki();
    await logTab.checkConflicts();
    setSyncStatus('synced');
  } catch {
    setSyncStatus('offline');
  }
}

async function startApp(handle) {
  $('date-label').textContent   = fmtDate(TODAY);
  $('author-label').textContent = s.author;

  if (handle && FSA_SUPPORTED) {
    const perm = await vault.queryPermission(handle);
    if (perm === 'granted') {
      s.vault = handle;
      setSyncStatus('synced');
    } else {
      showVaultBanner('reauth');
    }
  } else if (FSA_SUPPORTED) {
    showVaultBanner('first');
  }
  // FSA unsupported: no banner. Capture + settings work; log/photos/wiki idle.

  setupTabs();
  logTab.setupLogTab();
  wikiUi.setupWikiTab();
  captureUi.initCaptureUi();
  maybeAddTestStripButton();
  settingsUi.init();

  await logTab.loadAvailableDays();
  await logTab.loadLog();
  await loadWiki();
  if (s.vault) {
    await logTab.syncQueue();
    await logTab.checkConflicts();
  } else if (settings.get(GITHUB_PAT) && settings.get(GITHUB_REPO)) {
    // No FSA vault but GitHub is configured — green if online, red if not.
    setSyncStatus(navigator.onLine ? 'synced' : 'offline');
    tryFlush();
  }
}

// Settings' Test connection emits this event so the dot reflects reality.
window.addEventListener('sync-status', e => setSyncStatus(e.detail));

// Network-level reactivity — flip the dot the moment connectivity changes,
// before the user spends effort composing a capture.
window.addEventListener('offline', () => setSyncStatus('offline'));
window.addEventListener('online',  () => {
  if (s.vault) return; // FSA-driven status takes priority when a vault is connected
  if (settings.get(GITHUB_PAT) && settings.get(GITHUB_REPO)) {
    setSyncStatus('synced');
    tryFlush();
  }
});

function showVaultBanner(mode) {
  const banner = $('vault-banner');
  const msg    = banner.querySelector('span');
  const btn    = $('reconnect-btn');
  if (mode === 'first') {
    msg.textContent = 'Connect a vault folder to enable log and photos';
    btn.textContent = 'Choose folder';
    btn.dataset.mode = 'first';
  } else {
    msg.textContent = 'Vault folder needs access — entries saving locally';
    btn.textContent = 'Authorize';
    btn.dataset.mode = 'reauth';
  }
  banner.classList.add('show');
}

$('reconnect-btn').addEventListener('click', async () => {
  if ($('reconnect-btn').dataset.mode === 'first') {
    $('vault-setup-error').textContent = '';
    show('vault-setup-overlay');
    return;
  }
  const handle = await getVaultHandle();
  if (!handle) return;
  const ok = await vault.requestPermission(handle);
  if (ok) await activateVault(handle);
});

$('conflict-dismiss').addEventListener('click', () => hideBanner('conflict-banner'));

// Dev-only "Test strip" button injected into the wiki cap-row when ?dev=1.
// Could move to today-strip.js's own setup later; kept here as a small
// bootstrap-level toggle for now.
function maybeAddTestStripButton() {
  if (!location.search.includes('dev=1')) return;
  const testBtn = document.createElement('button');
  testBtn.className = 'wiki-cap-btn';
  testBtn.textContent = 'Test strip';
  testBtn.style.marginRight = '6px';
  testBtn.addEventListener('click', todayStrip.renderTestStrip);
  $('wiki-cap-row').prepend(testBtn);
}

$('reset-btn-1').addEventListener('click', resetApp);
$('reset-btn-2').addEventListener('click', resetApp);

setInterval(todayStrip.renderTodayStrip, 60000);

init();
