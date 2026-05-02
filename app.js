import * as settingsUi from './settings/settings-ui.js';
import { loadWiki } from './tabs/wiki/wiki.js';
import * as queue from './services/queue.js';
import * as settings from './services/settings.js';
import { GITHUB_PAT, GITHUB_REPO } from './services/settings.js';
import { $, $$, show, hide, fmtDate, setSyncStatus } from './core/ui.js';
import { s, TODAY } from './core/state.js';
import * as tripCtx from './services/trip-context.js';
import * as wikiUi from './tabs/wiki/wiki-ui.js';
import * as todayStrip from './tabs/wiki/today-strip.js';
import * as captureUi from './tabs/capture/capture-ui.js';
import * as logTab from './tabs/log/log.js';
import * as refresh from './services/refresh.js';
import * as ops from './services/ops.js';
import { setupTabs } from './core/router.js';

// ---- Boot ----
const VERSION = 74; // bump in lockstep with sw.js CACHE on every push

// Stamp the version into the bottom-right of the app shell at module load.
// Visible on every screen for at-a-glance "did the new build land?"
// debugging. Tap it to force a clean reload — unregisters every SW,
// deletes every cache, hard-reloads. Useful escape hatch when you know
// a deploy has landed but the SW poll hasn't caught it yet.
{
  const el = document.getElementById('app-version');
  if (el) {
    el.textContent = 'v' + VERSION;
    el.style.cursor = 'pointer';
    el.title = 'Tap to force-reload from server';
    el.addEventListener('click', async () => {
      if (!confirm('Force reload from server?\n\nClears caches and re-fetches every file. Use when you know a new version was just deployed.')) return;
      el.textContent = 'updating…';
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (err) {
        console.error('[force-reload] cleanup failed:', err);
      }
      location.reload();
    });
  }
}

async function init() {
  if ('serviceWorker' in navigator) {
    // updateViaCache: 'none' tells the browser to bypass HTTP cache for sw.js
    // itself, so a content change on the deployed file always triggers a new
    // SW install (instead of waiting for the default 24-hour update cycle).
    const reg = await navigator.serviceWorker.register('./sw.js?v=' + VERSION, {
      updateViaCache: 'none',
    }).catch(() => null);
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
    if (reg) {
      reg.update().catch(() => {});
      // Re-check whenever the app comes back to foreground.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      // Poll every 30s while the tab is visible — Firefox Android
      // otherwise honours the HTTP cache TTL on sw.js and can sit on a
      // stale build for several minutes after a deploy with no
      // visibilitychange to trigger an update check. The wall on
      // perceived latency is GH Pages build + Fastly CDN propagation;
      // the version stamp's tap-to-force-reload is the escape hatch.
      setInterval(() => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      }, 30_000);
    }
  }
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // First launch — author selection.
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

  hide('setup-overlay');
  await bootApp();
}

async function bootApp() {
  show('app');
  await startApp();
}

// Best-effort drain of the offline raw-capture queue (wiki captures). Called
// on boot, the 'online' event, settings save, settings test pass, and after
// any successful capture PUT.
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

window.addEventListener('try-flush', tryFlush);

async function resetApp() {
  localStorage.clear();
  for (const db of ['travel-vault', 'tv-timeline', 'tv-thumbs']) {
    try { indexedDB.deleteDatabase(db); } catch {}
  }
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map(r => r.unregister()));
  }
  window.location.reload();
}

async function startApp() {
  $('author-label').textContent = s.author;

  setupTabs();
  logTab.setupLogTab();
  wikiUi.setupWikiTab();
  captureUi.initCaptureUi();
  maybeAddTestStripButton();
  settingsUi.init();

  // Trip header — render asap with whatever's local, then refine after
  // _trips.json fetch so name/dates land on first paint where possible.
  renderTripHeader();
  tripCtx.trips().then(renderTripHeader).catch(() => {});
  window.addEventListener('trip-changed', () => { renderTripHeader(); });
  // Day nav changes which day "Day X of Y" reflects — re-render on switch.
  window.addEventListener('viewed-day-changed', () => renderTripHeader());

  await logTab.loadAvailableDays();
  await logTab.loadLog();
  await loadWiki();

  if (settings.get(GITHUB_PAT) && settings.get(GITHUB_REPO)) {
    setSyncStatus(navigator.onLine ? 'synced' : 'offline');
    tryFlush();
  }
}

// ── Trip header ────────────────────────────────────────────────────────────
// Top line: trip name. Sub-line: date range + "Day X of Y" when the viewed
// date sits inside the range. Falls back to today's weekday when no trip
// dates are set, so the header never goes empty.
function renderTripHeader() {
  const trip = tripCtx.getActiveTripCached();
  const nameEl = $('header-trip-name');
  const subEl = $('header-trip-sub');
  const dateEl = $('date-label');
  if (!nameEl) return;
  nameEl.textContent = trip?.name || tripCtx.getActiveSlug() || '';
  const sub = buildTripSubLine(trip, s.viewedDate || TODAY);
  subEl.textContent = sub;
  // Fall back to weekday/date if the sub-line is empty (no trip dates set).
  dateEl.textContent = sub ? '' : fmtDate(TODAY);
}

function buildTripSubLine(trip, viewedDate) {
  if (!trip) return '';
  const start = trip.start_date;
  const end = trip.end_date;
  if (!start && !end) return '';
  const range = (start && end) ? `${fmtShort(start)}–${fmtShort(end)}` : (start ? `from ${fmtShort(start)}` : `until ${fmtShort(end)}`);
  if (start && end && viewedDate >= start && viewedDate <= end) {
    const dayN = daysBetween(start, viewedDate) + 1;
    const totalN = daysBetween(start, end) + 1;
    return `${range} · Day ${dayN} of ${totalN}`;
  }
  return range;
}

function fmtShort(iso) {
  // "2026-06-05" → "Jun 5"
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function daysBetween(a, b) {
  const ms = new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00');
  return Math.round(ms / 86400000);
}

// Settings' Test connection emits this event so the dot reflects reality.
window.addEventListener('sync-status', e => setSyncStatus(e.detail));

// Network-level reactivity — flip the dot the moment connectivity changes,
// before the user spends effort composing a capture.
window.addEventListener('offline', () => setSyncStatus('offline'));
window.addEventListener('online',  () => {
  if (settings.get(GITHUB_PAT) && settings.get(GITHUB_REPO)) {
    setSyncStatus('synced');
    tryFlush();
    drainOps();
    refresh.maybeRefresh(s.viewedDate).catch(() => {});
    loadWiki().catch(() => {});
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!navigator.onLine) return;
  if (!settings.get(GITHUB_PAT) || !settings.get(GITHUB_REPO)) return;
  refresh.maybeRefresh(s.viewedDate).catch(() => {});
  drainOps();
  loadWiki().catch(() => {});
});

// Best-effort drain of the timeline mutation queue (services/ops.js).
// Mirrors tryFlush for the wiki-raw queue. GitHubAuthError stops the drain;
// other errors leave remaining ops queued for the next trigger.
async function drainOps() {
  try {
    if ((await ops.count()) === 0) return;
  } catch { return; }
  try { await ops.flush(); }
  catch { /* auth — settings will surface */ }
}
window.addEventListener('try-flush', drainOps);

// Dev-only "Test strip" button injected into the wiki cap-row when ?dev=1.
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

setInterval(todayStrip.renderTodayStrip, 60000);

init();
