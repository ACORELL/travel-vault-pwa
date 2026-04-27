// Wiki tab — data loading. Pulls pages from the wiki service, populates state,
// and asks the two UI modules (today-strip, wiki-ui) to re-render.
import { s } from '../../core/state.js';
import * as settings from '../../services/settings.js';
import { GITHUB_PAT, GITHUB_REPO } from '../../services/settings.js';
import * as wikiService from '../../services/wiki.js';
import { renderWikiList } from './wiki-ui.js';
import { renderTodayStrip } from './today-strip.js';

const REFRESH_THROTTLE_MS = 30_000;
let lastRefreshAt = 0;
let inFlight = null;

function indicator() { return document.getElementById('wiki-sync-indicator'); }

function setIndicator(state, label) {
  const el = indicator();
  if (!el) return;
  el.classList.remove('syncing', 'synced', 'offline', 'error');
  if (state) el.classList.add(state);
  const labelEl = el.querySelector('.wiki-sync-label');
  if (labelEl) labelEl.textContent = label;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function loadWiki({ force = false } = {}) {
  if (!settings.get(GITHUB_PAT) || !settings.get(GITHUB_REPO)) {
    setIndicator(null, 'No repo');
    return;
  }
  if (!navigator.onLine) {
    setIndicator('offline', lastRefreshAt ? `Offline · last ${fmtTime(lastRefreshAt)}` : 'Offline');
    return;
  }
  if (!force && inFlight) return inFlight;
  if (!force && Date.now() - lastRefreshAt < REFRESH_THROTTLE_MS) return;

  setIndicator('syncing', 'Syncing…');
  inFlight = (async () => {
    try {
      s.wikiPages = await wikiService.loadWikiPages();
      lastRefreshAt = Date.now();
      renderTodayStrip();
      renderWikiList(document.getElementById('wiki-search')?.value?.toLowerCase()?.trim() || '');
      setIndicator('synced', `Synced ${fmtTime(lastRefreshAt)}`);
    } catch (err) {
      setIndicator('error', 'Sync failed — tap to retry');
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Tap-to-retry / force-refresh on the indicator.
document.addEventListener('DOMContentLoaded', () => {
  const el = indicator();
  if (el) el.addEventListener('click', () => loadWiki({ force: true }));
});
