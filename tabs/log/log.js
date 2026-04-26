// Log tab — handlers, FSA queue drain, log parsing, day navigation, proximity check.
// Phase 4 will rewrite the I/O paths against github.js + queue.js and delete vault.js.
import { $, show, hide, nowHHMM, nowHHMMSS, setSyncStatus, showBanner } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import { enqueueLogEntry, getLogQueue, clearLogKeys } from '../../db.js';
import * as vault from '../../vault.js';
import * as geoloc from '../../services/location.js';
import * as logUi from './log-ui.js';

const CHECKIN_PROXIMITY_THRESHOLD_M = 400;

// ---- Queue flush (FSA path — drains the IndexedDB log queue to the vault folder) ----
export async function syncQueue() {
  const { items: logItems, keys: logKeys } = await getLogQueue();
  if (!logItems.length) return;

  setSyncStatus('syncing');
  try {
    const byDate = {};
    for (let i = 0; i < logItems.length; i++) {
      const item = logItems[i];
      if (!byDate[item.date]) byDate[item.date] = { lines: [], keys: [], photos: [] };
      byDate[item.date].lines.push(item.line);
      byDate[item.date].keys.push(logKeys[i]);
      if (item.photoFile && item.photoName) byDate[item.date].photos.push(item);
    }
    for (const [date, { lines, keys, photos }] of Object.entries(byDate)) {
      await vault.appendLogLines(s.vault, date, lines);
      for (const p of photos) await vault.savePhoto(s.vault, date, p.photoFile, p.photoName);
      await clearLogKeys(keys);
    }
    setSyncStatus('synced');
  } catch (e) {
    console.error('Sync failed:', e);
    setSyncStatus('offline');
    showBanner();
  }
}

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
  $('photo-pick-area').addEventListener('click', () => $('photo-input').click());
  $('photo-cancel').addEventListener('click',  cancelPhotoForm);
  $('photo-confirm').addEventListener('click', submitPhoto);
  $('photo-comment').addEventListener('input', () => {
    $('photo-confirm').disabled = !$('photo-comment').value.trim();
  });

  $('day-prev').addEventListener('click', () => navigateDay(-1));
  $('day-next').addEventListener('click', () => navigateDay(1));

  $('btn-pending-checkin').addEventListener('click', async () => {
    $('btn-pending-checkin').disabled = true;
    $('btn-pending-checkin').textContent = 'Getting GPS…';
    await checkIn();
    // checkIn() handles draft auto-submit and restores btn-pending-checkin state
    // via hidePendingDraft(); resetting its text is harmless but good practice
    $('btn-pending-checkin').disabled = false;
    $('btn-pending-checkin').textContent = '📍 Check in here';
  });
}

async function checkIn() {
  const btn = $('btn-checkin');
  btn.disabled = true;
  btn.textContent = 'Getting GPS…';

  const time = nowHHMM();
  const gps = await geoloc.sample({ timeout: 10000, maximumAge: 0 });

  const gpsPart = gps ? ` | ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  await writeLogLine(`${time} | ${s.author} | 📍${gpsPart}`);

  // If a draft was pending proximity check, auto-submit it now under this new check-in
  const draft = s.pendingDraft;
  if (draft) {
    logUi.hidePendingDraft();   // clears s.pendingDraft, restores add-bar
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

  const { status: proximity } = await checkProximity();

  btn.textContent = 'Add';

  // If the user cancelled the form while GPS was resolving, discard silently
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
  await writeLogLine(`${nowHHMM()} | ${s.author} | ${text}`);
  await loadLog();
}

async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  s.pendingPhoto = { file, ts: nowHHMMSS() };

  const prev = $('photo-preview');
  const reader = new FileReader();
  reader.onload = () => { prev.src = reader.result; };
  reader.readAsDataURL(file);
  $('photo-pick-area').style.display = 'none';
  $('photo-comment').disabled = false;
  $('photo-comment').value = '';
  $('photo-confirm').disabled = true;
  $('photo-confirm').textContent = 'Add';
  show('photo-form');
}

function cancelPhotoForm() {
  hide('photo-form');
  const prev = $('photo-preview');
  prev.removeAttribute('src');
  $('photo-pick-area').style.display = 'flex';
  $('photo-comment').value = '';
  $('photo-comment').disabled = true;
  s.pendingPhoto = null;
}

async function submitPhoto() {
  const comment = $('photo-comment').value.trim();
  if (!comment || !s.pendingPhoto) return;

  const { file, ts } = s.pendingPhoto;  // capture before any awaits

  const btn = $('photo-confirm');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  const { status: proximity, gps } = await checkProximity();

  btn.textContent = 'Add';

  // If the user cancelled the form while GPS was resolving, discard silently
  if ($('photo-form').classList.contains('hidden')) {
    s.pendingPhoto = null;
    return;
  }

  if (proximity === 'out-of-range') {
    s.pendingPhoto = null;
    cancelPhotoForm();
    s.pendingDraft = { type: 'photo', file, ts, comment, gps };
    logUi.showPendingDraft(`📷 "${comment}"`);
    return;
  }

  s.pendingPhoto = null;
  cancelPhotoForm();
  await finishPhotoWrite(file, ts, comment, gps);
  await loadLog();
}

async function finishPhotoWrite(file, ts, comment, gps) {
  const hms  = ts.replace(/:/g, '-');
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const base = `${hms}_${s.author}`;
  const name = await resolvePhotoName(base, ext);
  const time = ts.slice(0, 5);
  const gpsPart = gps ? ` | ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  const line = `${time} | ${s.author} | 📷 ${name}${gpsPart} | "${comment}"`;

  if (s.vault) {
    try {
      await vault.savePhoto(s.vault, TODAY, file, name);
      await vault.appendLogLines(s.vault, TODAY, [line]);
    } catch {
      await enqueueLogEntry({ date: TODAY, line, photoFile: file, photoName: name });
      setSyncStatus('offline');
      showBanner();
    }
  } else {
    await enqueueLogEntry({ date: TODAY, line, photoFile: file, photoName: name });
  }
}

async function resolvePhotoName(base, ext) {
  if (!s.vault) return `${base}.${ext}`;
  let name = `${base}.${ext}`, n = 2;
  while (await vault.photoExists(s.vault, TODAY, name)) { name = `${base}_${n++}.${ext}`; }
  return name;
}

async function writeLogLine(line) {
  if (s.vault) {
    try { await vault.appendLogLines(s.vault, TODAY, [line]); setSyncStatus('synced'); return; }
    catch { setSyncStatus('offline'); showBanner(); }
  }
  await enqueueLogEntry({ date: TODAY, line });
}

export async function loadLog() {
  s.logEntries = [];

  if (s.vault) {
    try {
      const text = await vault.readLogMd(s.vault, s.viewedDate);
      if (text) s.logEntries = parseLogMd(text);
    } catch {}
  }

  const { items } = await getLogQueue();
  for (const item of items) {
    if (item.date === s.viewedDate) {
      const parsed = parseLogLine(item.line);
      if (parsed) s.logEntries.push(parsed);
    }
  }
  s.logEntries.sort((a, b) => a.time.localeCompare(b.time));
  logUi.updateDayNavUI();
  logUi.updateActionBarState();
  logUi.renderLog();
}

function parseLogMd(text) {
  let skip = 0;
  return text.split('\n').filter(line => {
    if (line === '---') { if (skip < 2) { skip++; return false; } }
    return skip >= 2 && line.trim();
  }).map(parseLogLine).filter(Boolean);
}

function parseLogLine(line) {
  const parts = line.split(' | ');
  if (parts.length < 3) return null;
  const [time, author, ...rest] = parts;
  const body = rest.join(' | ');
  if (body.startsWith('📍')) {
    const gpsMatch = body.match(/📍\s*\|\s*([-\d.]+),([-\d.]+)/);
    const gps = gpsMatch ? { lat: parseFloat(gpsMatch[1]), lon: parseFloat(gpsMatch[2]) } : null;
    return { time: time.trim(), author: author.trim(), type: 'checkin', gps };
  }
  if (body.startsWith('📷')) {
    // Backward compatible: GPS chunk is optional. 📷 name [| lat,lon] | "comment"
    const m = body.match(/📷\s*(\S+)(?:\s*\|\s*([-\d.]+),([-\d.]+))?\s*\|\s*"?(.+?)"?\s*$/);
    if (m) {
      const gps = m[2] && m[3] ? { lat: parseFloat(m[2]), lon: parseFloat(m[3]) } : null;
      return { time: time.trim(), author: author.trim(), type: 'photo', photo: m[1], gps, comment: m[4] };
    }
    return { time: time.trim(), author: author.trim(), type: 'photo', photo: '', gps: null, comment: '' };
  }
  return { time: time.trim(), author: author.trim(), type: 'text', text: body };
}

// ---- Day navigation ----

export async function loadAvailableDays() {
  if (!s.vault) {
    s.availableDays = [TODAY];
    return;
  }
  const days = await vault.listDayFolders(s.vault);
  if (!days.includes(TODAY)) days.push(TODAY);
  s.availableDays = days.sort();
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

export async function checkConflicts() {
  if (!s.vault) return;
  const found = await vault.detectConflicts(s.vault, TODAY);
  if (found.length) {
    $('conflict-msg').textContent =
      `Sync conflict in log.md — resolve in Obsidian (${found.length} file${found.length > 1 ? 's' : ''})`;
    showBanner('conflict-banner');
  }
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

function sampleGpsForProximity() {
  return geoloc.sample({ timeout: 5000, maximumAge: 60000 });
}

// Returns { status, gps }. status is 'ok' or 'out-of-range'. gps is the current
// sample (or null if unavailable) — callers attach it to photo entries.
async function checkProximity() {
  const currentGps = await sampleGpsForProximity();
  const checkinGps = getLastCheckinGps();
  if (!checkinGps || !currentGps) return { status: 'ok', gps: currentGps };
  const dist = haversineMetres(checkinGps.lat, checkinGps.lon, currentGps.lat, currentGps.lon);
  return { status: dist <= CHECKIN_PROXIMITY_THRESHOLD_M ? 'ok' : 'out-of-range', gps: currentGps };
}

// Writes a pending draft entry to the log without calling loadLog().
// Called from checkIn() after the new check-in line is already written.
async function autoSubmitDraft(draft) {
  if (draft.type === 'note') {
    await writeLogLine(`${nowHHMM()} | ${s.author} | ${draft.text}`);
  } else if (draft.type === 'photo') {
    await finishPhotoWrite(draft.file, draft.ts, draft.comment, draft.gps);
  }
}
