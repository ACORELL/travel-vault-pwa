// Log tab — capture handlers, day navigation, refresh button (Phase 5).
//
// Writes go straight to atomicEdit (services/timeline.js): fetch sha → run
// mutator → PUT with sha. On a network failure the optimistic local cache
// update is treated as authoritative and the op is parked in services/ops.js
// for a later flush. Reads are cache-first via timeline.getCached, falling
// back to refresh.fetchDay on cache miss.
//
// Steps 7-9 add detail view, edit/delete, and append wired into the same
// surface; step 6 ships only check-in / note / photo capture + read +
// the manual Refresh button.

import { $, show, hide } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import * as geoloc from '../../services/location.js';
import {
  addEntry, getCached, putCached,
  listAvailableDates, makeId,
} from '../../services/timeline.js';
import {
  generateFromFile, storeLocal,
} from '../../services/thumbs.js';
import {
  fetchDay, maybeRefresh, lastRefreshedAt, isAutoRefreshDue,
} from '../../services/refresh.js';
import * as ops from '../../services/ops.js';
import { putFile, GitHubAuthError } from '../../services/github.js';
import * as logUi from './log-ui.js';
import * as detail from './detail.js';

// Local-implicit ISO datetime (no Z, no offset). The trip is one timezone;
// the assembly PWA at home will canonicalise if it ever needs to.
function nowLocalIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function byT(a, b) {
  return (a.t || '').localeCompare(b.t || '');
}

// ─── Setup ────────────────────────────────────────────────────────────────────

export function setupLogTab() {
  $('btn-checkin').addEventListener('click', addCheckin);
  $('btn-add-note').addEventListener('click', openNoteForm);
  $('note-cancel').addEventListener('click',  closeNoteForm);
  $('note-confirm').addEventListener('click', submitNote);
  $('note-text').addEventListener('input', () => {
    $('note-confirm').disabled = !$('note-text').value.trim();
  });

  $('btn-add-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', onPhotoSelected);
  $('photo-cancel').addEventListener('click',  closePhotoForm);
  $('photo-confirm').addEventListener('click', submitPhoto);
  $('photo-comment').addEventListener('input', () => {
    $('photo-confirm').disabled = !$('photo-comment').value.trim();
  });
  $('photo-replace').addEventListener('click', () => $('photo-input').click());

  $('day-prev').addEventListener('click', () => navigateDay(-1));
  $('day-next').addEventListener('click', () => navigateDay(1));

  // The Refresh button + label use Phase-5 IDs (#btn-refresh /
  // #last-refreshed-label). Step 7's index.html pass renames the existing
  // #btn-sync / #last-synced-label markup to match.
  const refreshBtn = $('btn-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', runManualRefresh);
  updateLastRefreshedLabel();

  detail.setupDetailView();

  // Re-render after restoreFromRepo finishes hydrating IDB.
  window.addEventListener('timeline-restored', () => loadLog());
  // Re-render whenever the cache for the viewed date changes — fires on
  // atomicEdit's tail (own writes) and on refresh.fetchDay (other devices).
  window.addEventListener('day-changed', e => {
    if (e.detail?.date === s.viewedDate) {
      loadLog();
      updateLastRefreshedLabel();
    }
  });
}

// ─── Capture ──────────────────────────────────────────────────────────────────

async function addCheckin() {
  const btn = $('btn-checkin');
  btn.disabled = true;
  btn.textContent = 'Getting GPS…';
  try {
    const gps = await geoloc.sample({ timeout: 10000, maximumAge: 0 });
    const t   = nowLocalIso();
    const cached = await getCached(s.viewedDate);
    const id  = makeId(t, s.author, cached?.entries || []);
    const entry = {
      id, type: 'checkin', author: s.author, t,
      gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
    };
    await commitAdd(s.viewedDate, entry);
  } finally {
    btn.disabled = false;
    btn.textContent = '📍 Check in';
  }
}

function openNoteForm() {
  s.composing = { kind: 'add-note' };
  $('note-text').value = '';
  $('note-confirm').disabled = true;
  $('note-confirm').textContent = 'Add';
  show('note-form');
  $('note-text').focus();
}

function closeNoteForm() {
  hide('note-form');
  $('note-text').value = '';
  s.composing = null;
}

async function submitNote() {
  const text = $('note-text').value.trim();
  if (!text) return;
  if (s.composing?.kind !== 'add-note') return;

  const btn = $('note-confirm');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  const gps = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
  const t   = nowLocalIso();
  const cached = await getCached(s.viewedDate);
  const id  = makeId(t, s.author, cached?.entries || []);
  const entry = {
    id, type: 'note', author: s.author, t,
    content: text,
    gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
  };

  closeNoteForm();
  await commitAdd(s.viewedDate, entry);
}

async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const t = nowLocalIso();
  s.composing = { kind: 'add-photo', file, t };

  const prev = $('photo-preview');
  if (prev._url) URL.revokeObjectURL(prev._url);
  prev._url = URL.createObjectURL(file);
  prev.src = prev._url;
  prev.hidden = false;

  const gps = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
  if (s.composing?.kind === 'add-photo') {
    s.composing.gps = gps ? { lat: gps.lat, lon: gps.lon } : null;
  }
  const meta = $('photo-preview-meta');
  const gpsLine = gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` : 'GPS unavailable';
  meta.textContent = `${file.name || '(unnamed)'} · ${gpsLine}`;
  meta.hidden = false;

  $('photo-comment').value = '';
  $('photo-comment').disabled = false;
  $('photo-confirm').disabled = true;
  $('photo-confirm').textContent = 'Add';
  $('photo-replace').hidden = true;
  show('photo-form');
}

function closePhotoForm() {
  hide('photo-form');
  $('photo-comment').value = '';
  $('photo-comment').disabled = true;
  const prev = $('photo-preview');
  if (prev._url) { URL.revokeObjectURL(prev._url); prev._url = null; }
  prev.removeAttribute('src');
  prev.hidden = true;
  $('photo-preview-meta').hidden = true;
  $('photo-replace').hidden = true;
  s.composing = null;
}

async function submitPhoto() {
  const comment = $('photo-comment').value.trim();
  if (!comment) return;
  if (s.composing?.kind !== 'add-photo' || !s.composing.file) return;

  const { file, t, gps } = s.composing;
  const btn = $('photo-confirm');
  btn.disabled = true;
  btn.textContent = 'Adding…';

  const date = s.viewedDate;
  const hms  = t.slice(11, 19).replace(/:/g, '');
  const ext  = (file.name?.split('.').pop() || 'jpg').toLowerCase();
  const ref  = `${date}_${hms}_${s.author}.${ext}`;
  const cached = await getCached(date);
  const id   = makeId(t, s.author, cached?.entries || []);
  const entry = {
    id, type: 'photo', author: s.author, t,
    ref, comment,
    gps: gps || null,
  };

  closePhotoForm();
  await commitAddPhoto(date, entry, file);
}

// ─── Commit helpers ───────────────────────────────────────────────────────────

// Optimistically update the local cache so the UI reflects the new entry
// immediately. atomicEdit's tail will overwrite the cache with the canonical
// shape (including any entries the other device added) on success; on
// network failure, this optimistic state survives until the queued op drains.
async function applyOptimistic(date, mutator) {
  const cached = await getCached(date);
  const next   = mutator(cached?.entries || []);
  // Reuse the existing sha — atomicEdit fetches sha fresh anyway, so a stale
  // sha in cache doesn't break writes. The 'day-changed' emit re-renders.
  await putCached(date, next, cached?.sha);
}

async function commitAdd(date, entry) {
  await applyOptimistic(date, xs => [...xs, entry].sort(byT));
  try {
    await addEntry(date, entry);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'add-entry', date, args: { entry } });
  }
}

async function commitAddPhoto(date, entry, file) {
  const blob = await generateFromFile(file);
  await storeLocal(entry.ref, blob);
  await applyOptimistic(date, xs => [...xs, entry].sort(byT));

  // Thumb first so the timeline.json never points at a missing file. If the
  // thumb upload fails (non-auth), queue both ops in order — entry can't
  // ship before its thumb does.
  let thumbDirect = false;
  try {
    await putFile(`days/${date}/thumbs/${entry.ref}`, blob,
                  `Add thumbnail ${entry.ref}`);
    thumbDirect = true;
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'put-thumb', date, args: { ref: entry.ref } });
  }

  if (!thumbDirect) {
    await ops.enqueue({ kind: 'add-entry', date, args: { entry } });
    return;
  }
  try {
    await addEntry(date, entry);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'add-entry', date, args: { entry } });
  }
}

// ─── Read path ────────────────────────────────────────────────────────────────

export async function loadLog() {
  let entries;
  const cached = await getCached(s.viewedDate);
  if (cached) {
    entries = cached.entries;
  } else {
    try {
      entries = await fetchDay(s.viewedDate);
    } catch (e) {
      if (e instanceof GitHubAuthError) throw e;
      entries = [];
    }
  }
  s.logEntries = entries;
  logUi.updateDayNavUI();
  logUi.updateActionBarState();
  await logUi.renderLog();
}

// ─── Day navigation ───────────────────────────────────────────────────────────

export async function loadAvailableDays() {
  try { s.availableDays = await listAvailableDates(); }
  catch { s.availableDays = [TODAY]; }
}

async function navigateDay(dir) {
  await loadAvailableDays();
  const idx = s.availableDays.indexOf(s.viewedDate);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= s.availableDays.length) return;
  s.viewedDate = s.availableDays[newIdx];
  await loadLog();
  // Background refresh for the just-navigated date so cross-device updates
  // surface without requiring a manual tap on Refresh.
  fetchDay(s.viewedDate).catch(() => {});
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

async function runManualRefresh() {
  const btn = $('btn-refresh');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await fetchDay(s.viewedDate, { force: true });
    btn.textContent = 'Refresh';
  } catch (e) {
    btn.textContent = 'Refresh';
    const label = $('last-refreshed-label');
    if (label) {
      label.textContent = e instanceof GitHubAuthError
        ? 'Auth error — check settings'
        : 'Refresh failed';
    }
  } finally {
    btn.disabled = false;
  }
}

async function updateLastRefreshedLabel() {
  const el = $('last-refreshed-label');
  if (!el) return;
  const ts = await lastRefreshedAt(s.viewedDate);
  if (!ts) { el.textContent = 'Not refreshed yet'; return; }
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  el.textContent = `Last refreshed ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Triggered by app.js on foreground / online — opportunistic, throttled
// refresh of the currently-viewed date. Step 10 will replace the call site
// with refresh.maybeRefresh directly and drop this wrapper.
export async function autoSync() {
  if (!isAutoRefreshDue(s.viewedDate)) return;
  try { await maybeRefresh(s.viewedDate); }
  catch {}
}
