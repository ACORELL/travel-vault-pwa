// Log tab — capture handlers, day navigation, proximity check.
// Phase 4: writes go to the local timeline via services/timeline.js; thumbs
// generated and stored via services/thumbs.js. Sync to GitHub is deferred
// (services/sync.js, wired in step 6). vault.js + db.js are no longer used
// from this tab and are deleted entirely in step 8.
import { $, show, hide, nowHHMMSS } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import * as geoloc from '../../services/location.js';
import * as timeline from '../../services/timeline.js';
import * as thumbs from '../../services/thumbs.js';
import * as sync from '../../services/sync.js';
import { GitHubAuthError } from '../../services/github.js';
import * as logUi from './log-ui.js';

const CHECKIN_PROXIMITY_THRESHOLD_M = 400;

// Local-implicit ISO datetime (no Z, no offset). The trip is one timezone;
// the assembly PWA at home will canonicalise if it ever needs to.
function nowLocalIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeId() {
  return `${nowHHMMSS().replace(/:/g, '')}_${s.author}`;
}

// No-op stubs — app.js still calls these until step 7 removes the FSA-flow
// branches. They are removed alongside activateVault in that step.
export async function syncQueue() {}
export async function checkConflicts() {}

// ---- Log tab setup ----
export function setupLogTab() {
  $('btn-checkin').addEventListener('click', checkIn);
  $('btn-add-note').addEventListener('click', openNoteForm);
  $('note-cancel').addEventListener('click',  () => hide('note-form'));
  $('note-confirm').addEventListener('click', submitNote);
  $('note-text').addEventListener('input', () => {
    $('note-confirm').disabled = !$('note-text').value.trim();
  });

  $('btn-add-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', onPhotoSelected);
  $('photo-cancel').addEventListener('click',  cancelPhotoForm);
  $('photo-confirm').addEventListener('click', submitPhoto);
  $('photo-comment').addEventListener('input', () => {
    $('photo-confirm').disabled = !$('photo-comment').value.trim();
  });

  $('day-prev').addEventListener('click', () => navigateDay(-1));
  $('day-next').addEventListener('click', () => navigateDay(1));

  $('btn-sync').addEventListener('click', runManualSync);
  updateLastSyncedLabel();

  $('btn-pending-checkin').addEventListener('click', async () => {
    $('btn-pending-checkin').disabled = true;
    $('btn-pending-checkin').textContent = 'Getting GPS…';
    await checkIn();
    $('btn-pending-checkin').disabled = false;
    $('btn-pending-checkin').textContent = '📍 Check in here';
  });
}

async function checkIn() {
  const btn = $('btn-checkin');
  btn.disabled = true;
  btn.textContent = 'Getting GPS…';

  const gps = await geoloc.sample({ timeout: 10000, maximumAge: 0 });
  await timeline.appendLocal(TODAY, {
    id: makeId(),
    type: 'checkin',
    t: nowLocalIso(),
    gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
  });

  const draft = s.pendingDraft;
  if (draft) {
    logUi.hidePendingDraft();
    await autoSubmitDraft(draft);
  }

  await loadLog();

  btn.disabled = false;
  btn.textContent = '📍 Check in';
}

function openNoteForm() {
  $('note-text').value = '';
  $('note-confirm').disabled = true;
  $('note-confirm').textContent = 'Add';
  show('note-form');
  $('note-text').focus();
}

async function submitNote() {
  const text = $('note-text').value.trim();
  if (!text) return;

  const btn = $('note-confirm');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  const gps = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
  const proximity = proximityFromGps(gps);
  btn.textContent = 'Add';

  if ($('note-form').classList.contains('hidden')) return;

  if (proximity === 'out-of-range') {
    hide('note-form');
    $('note-text').value = '';
    s.pendingDraft = { type: 'note', text };
    logUi.showPendingDraft(text);
    return;
  }

  hide('note-form');
  $('note-text').value = '';
  await timeline.appendLocal(TODAY, {
    id: makeId(),
    type: 'note',
    t: nowLocalIso(),
    content: text,
    gps: gps ? { lat: gps.lat, lon: gps.lon } : null,
  });
  await loadLog();
}

// D5: no preview. Tapping "+ Photo" opens the camera (capture="environment"
// on #photo-input); selecting a photo brings up the comment form directly.
async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const t = nowLocalIso();
  s.pendingPhoto = { file, t };

  // Preview: cap at 400px height (CSS), aspect ratio preserved. Comments
  // field stays in the viewport without scrolling on tall portraits.
  const prev = $('photo-preview');
  if (prev._url) URL.revokeObjectURL(prev._url);
  prev._url = URL.createObjectURL(file);
  prev.src = prev._url;
  prev.hidden = false;

  // Sample GPS for the preview meta (and reuse on submit).
  const gps = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
  s.pendingPhoto.gps = gps ? { lat: gps.lat, lon: gps.lon } : null;
  const meta = $('photo-preview-meta');
  const gpsLine = gps ? `${gps.lat.toFixed(5)}, ${gps.lon.toFixed(5)}` : 'GPS unavailable';
  meta.textContent = `${file.name || '(unnamed)'} · ${gpsLine}`;
  meta.hidden = false;

  $('photo-comment').value = '';
  $('photo-comment').disabled = false;
  $('photo-confirm').disabled = true;
  $('photo-confirm').textContent = 'Add';
  show('photo-form');
}

function cancelPhotoForm() {
  hide('photo-form');
  $('photo-comment').value = '';
  $('photo-comment').disabled = true;
  const prev = $('photo-preview');
  if (prev._url) { URL.revokeObjectURL(prev._url); prev._url = null; }
  prev.removeAttribute('src');
  prev.hidden = true;
  $('photo-preview-meta').hidden = true;
  s.pendingPhoto = null;
}

async function submitPhoto() {
  const comment = $('photo-comment').value.trim();
  if (!comment || !s.pendingPhoto) return;

  const { file, t, gps } = s.pendingPhoto;
  const btn = $('photo-confirm');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  const proximity = proximityFromGps(gps);
  btn.textContent = 'Add';

  if ($('photo-form').classList.contains('hidden')) {
    s.pendingPhoto = null;
    return;
  }

  if (proximity === 'out-of-range') {
    s.pendingPhoto = null;
    cancelPhotoForm();
    s.pendingDraft = { type: 'photo', file, t, comment, gps };
    logUi.showPendingDraft(`📷 "${comment}"`);
    return;
  }

  s.pendingPhoto = null;
  cancelPhotoForm();
  await finishPhotoWrite(file, t, comment, gps);
  await loadLog();
}

async function finishPhotoWrite(file, t, comment, gps) {
  // ref = YYYY-MM-DD_HHMMSS_<author>.<ext> — date-prefixed so unsyncedRefs(date)
  // can filter by prefix; matches PHASE4.md §4 example.
  const hms = t.slice(11, 19).replace(/:/g, '');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const ref = `${TODAY}_${hms}_${s.author}.${ext}`;
  const id  = `${hms}_${s.author}`;

  const blob = await thumbs.generateFromFile(file);
  await thumbs.storeLocal(ref, blob);
  await timeline.appendLocal(TODAY, {
    id,
    type: 'photo',
    t,
    ref,
    comment,
    gps: gps || null,
  });
}

export async function loadLog() {
  // getCombined returns own (from local IDB) ∪ other-author (fetched + cached
  // from the data repo), each entry tagged with `author`. Renders sorted by t.
  s.logEntries = await timeline.getCombined(s.viewedDate);
  logUi.updateDayNavUI();
  logUi.updateActionBarState();
  await logUi.renderLog();
}

// ---- Day navigation ----
export async function loadAvailableDays() {
  try {
    s.availableDays = await timeline.listAvailableDates();
  } catch {
    s.availableDays = [TODAY];
  }
}

async function navigateDay(dir) {
  await loadAvailableDays();
  const idx = s.availableDays.indexOf(s.viewedDate);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= s.availableDays.length) return;
  s.viewedDate = s.availableDays[newIdx];
  await loadLog();
}

// ---- Proximity enforcement ----
function haversineMetres(lat1, lon1, lat2, lon2) {
  const R    = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLastCheckinGps() {
  for (let i = s.logEntries.length - 1; i >= 0; i--) {
    const e = s.logEntries[i];
    if (e.type === 'checkin' && e.gps) return e.gps;
  }
  return null;
}

function proximityFromGps(currentGps) {
  const checkinGps = getLastCheckinGps();
  if (!checkinGps) return 'ok';
  if (!currentGps) return 'ok';
  const dist = haversineMetres(checkinGps.lat, checkinGps.lon, currentGps.lat, currentGps.lon);
  return dist <= CHECKIN_PROXIMITY_THRESHOLD_M ? 'ok' : 'out-of-range';
}

async function runManualSync() {
  const btn = $('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await sync.syncToday();
    btn.textContent = 'Sync now';
    updateLastSyncedLabel();
    await loadLog();
  } catch (e) {
    btn.textContent = 'Sync now';
    if (e instanceof GitHubAuthError) {
      $('last-synced-label').textContent = 'Auth error — check settings';
    } else {
      $('last-synced-label').textContent = 'Sync failed';
    }
  } finally {
    btn.disabled = false;
  }
}

function updateLastSyncedLabel() {
  const ts = sync.lastSyncedAt();
  const el = $('last-synced-label');
  if (!ts) { el.textContent = 'Never synced'; return; }
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  el.textContent = `Last sync ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Triggered by app.js on foreground / online — quietly best-effort sync.
export async function autoSync() {
  if (!sync.isAutoSyncDue()) return;
  try {
    await sync.syncToday();
    updateLastSyncedLabel();
    await loadLog();
  } catch {}
}

async function autoSubmitDraft(draft) {
  if (draft.type === 'note') {
    await timeline.appendLocal(TODAY, {
      id: makeId(),
      type: 'note',
      t: nowLocalIso(),
      content: draft.text,
      gps: draft.gps || null,
    });
  } else if (draft.type === 'photo') {
    await finishPhotoWrite(draft.file, draft.t, draft.comment, draft.gps);
  }
}
