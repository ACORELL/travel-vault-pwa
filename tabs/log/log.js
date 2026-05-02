// Log tab — capture / edit / delete handlers, day navigation, refresh button.
//
// Writes go straight to atomicEdit (services/timeline.js): fetch sha → run
// mutator → PUT with sha. On network failure the optimistic local cache
// update is treated as authoritative and the op is parked in services/ops.js
// for a later flush. Reads are cache-first via timeline.getCached, falling
// back to refresh.fetchDay on cache miss.
//
// Step 6 added check-in / note / photo capture + read + Refresh.
// Step 7 added detail-view scaffolding.
// Step 8 wires Edit + Delete (parent and appendment, including check-in
//   cascade delete via timeline.deleteMany + best-effort thumb cleanup).
// Step 9 wires Append (+ Comment / + Photo from inside the detail view).

import { $, show, hide } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import * as geoloc from '../../services/location.js';
import {
  addEntry, editEntry, deleteEntry,
  addAppendment, editAppendment, deleteAppendment,
  deleteMany,
  getCached, putCached,
  listAvailableDates, makeId,
  addTombstone, addPendingAdd,
} from '../../services/timeline.js';
import {
  generateFromFile, storeLocal, setLocalSha, getLocalUrl, deleteLocal,
} from '../../services/thumbs.js';
import {
  fetchDay, lastRefreshedAt,
} from '../../services/refresh.js';
import * as ops from '../../services/ops.js';
import {
  putFile, deleteFile, getBinary,
  GitHubAuthError, GitHubNotFoundError,
} from '../../services/github.js';
import { daysPath } from '../../services/trip-context.js';
import { extractMeta } from '../../exif.js';
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

  const refreshBtn = $('btn-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', runManualRefresh);
  updateLastRefreshedLabel();

  detail.setupDetailView();

  // Detail-view action triggers (parent + appendment edit/delete). detail.js
  // dispatches; we listen here so the cycle stays one-way (log.js → detail.js).
  window.addEventListener('entry-edit-requested',           e => startEditEntry(e.detail.id));
  window.addEventListener('entry-replace-requested',        e => startReplaceEntry(e.detail.id));
  window.addEventListener('entry-delete-requested',         e => deleteEntryRequested(e.detail.id));
  window.addEventListener('checkin-delete-requested',       e => deleteCheckinGroupRequested(e.detail.id));
  window.addEventListener('appendment-edit-requested',      e => startEditAppendment(e.detail.parentId, e.detail.appId));
  window.addEventListener('appendment-replace-requested',   e => startReplaceAppendment(e.detail.parentId, e.detail.appId));
  window.addEventListener('appendment-delete-requested',    e => deleteAppendmentRequested(e.detail.parentId, e.detail.appId));
  window.addEventListener('appendment-add-comment-requested', e => startAddAppendmentComment(e.detail.parentId));
  window.addEventListener('appendment-add-photo-requested',   e => startAddAppendmentPhoto(e.detail.parentId));

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
  // Re-render when the ops queue changes so per-entry debug badges
  // (synced / pending / thumb) reflect the latest queue state.
  window.addEventListener('ops-changed', () => loadLog());
}

// ─── GPS / check-in coupling ──────────────────────────────────────────────────
//
// Check-ins are the trip's location heartbeat. New phone captures (notes,
// photos, appendments) follow this rule:
//
//   - Sample geolocation.
//   - If the sample is within GPS_TRUST_KM of any check-in already on this
//     day, attach the gps to the entry — same trip-segment, the existing
//     check-in covers it.
//   - If the sample is OUTSIDE the radius (or the day has no check-ins
//     yet), mint a new check-in at the sampled location just before the
//     entry, then attach the same gps to the entry. The trip's check-in
//     graph self-extends — the user doesn't have to manually check in
//     every time they move.
//   - If the sample fails (null), the entry gets gps: null and no
//     check-in is minted.
//
// Edits, Replace, and laptop-side picker flows are exempt — they don't
// sample live geolocation. Couch-curation from the laptop is location-free.
//
// 2 km is a conservative trip-walking radius. Tune via GPS_TRUST_KM.

const GPS_TRUST_KM = 2;

function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Subtract one second from an ISO timestamp (YYYY-MM-DDTHH:MM:SS). Used to
// place the auto-minted check-in just before the entry that triggered it.
function shiftIsoSeconds(iso, deltaSec) {
  const d = new Date(iso + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(d.getTime() + deltaSec * 1000).toISOString().slice(0, 19);
}

// Decide what to do with a sampled gps for a new capture on `date`.
// Returns { gps, mintedCheckin, distanceKm } where mintedCheckin (if
// non-null) must be committed BEFORE the triggering entry so atomicEdit's
// timeline ordering is consistent on read.
async function resolveGpsAndMaybeCheckin({ date, gps, t, author }) {
  if (!gps) return { gps: null, mintedCheckin: null, distanceKm: null };
  const cached = await getCached(date);
  const entries = cached?.entries || [];
  const checkins = entries.filter(e => e.type === 'checkin' && e.gps);
  let nearestKm = Infinity;
  for (const c of checkins) {
    const d = haversineKm(gps, c.gps);
    if (d < nearestKm) nearestKm = d;
  }
  if (checkins.length && nearestKm <= GPS_TRUST_KM) {
    return { gps, mintedCheckin: null, distanceKm: nearestKm };
  }
  // Outside radius (or no check-ins yet) — mint a check-in just before
  // the entry's t so it sorts immediately ahead.
  const checkinT = shiftIsoSeconds(t, -1);
  const mintedCheckin = {
    id: makeId(checkinT, author, entries),
    type: 'checkin',
    author,
    t: checkinT,
    gps,
  };
  return {
    gps,
    mintedCheckin,
    distanceKm: nearestKm === Infinity ? null : nearestKm,
  };
}

// ─── Capture (add) ────────────────────────────────────────────────────────────

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
  const c = s.composing;
  if (!c) return;
  const date = s.viewedDate;
  const btn = $('note-confirm');
  btn.disabled = true;
  btn.textContent = c.kind === 'add-note' ? 'Adding…' : 'Saving…';

  if (c.kind === 'add-note') {
    const sampled = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
    const sampledNorm = sampled ? { lat: sampled.lat, lon: sampled.lon } : null;
    const t   = nowLocalIso();
    const resolved = await resolveGpsAndMaybeCheckin({ date, gps: sampledNorm, t, author: s.author });
    const cached = await getCached(date);
    const id  = makeId(t, s.author, cached?.entries || []);
    const entry = {
      id, type: 'note', author: s.author, t,
      content: text,
      gps: resolved.gps,
    };
    closeNoteForm();
    if (resolved.mintedCheckin) await commitAdd(date, resolved.mintedCheckin);
    await commitAdd(date, entry);
  } else if (c.kind === 'edit-note') {
    const entryId = c.entryId;
    closeNoteForm();
    await commitEdit(date, entryId, { content: text });
  } else if (c.kind === 'edit-appendment-note') {
    const { parentId, appId } = c;
    closeNoteForm();
    await commitEditAppendment(date, parentId, appId, { content: text });
  } else if (c.kind === 'append-note') {
    const { parentId } = c;
    const sampled = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
    const sampledNorm = sampled ? { lat: sampled.lat, lon: sampled.lon } : null;
    const t   = nowLocalIso();
    const resolved = await resolveGpsAndMaybeCheckin({ date, gps: sampledNorm, t, author: s.author });
    const cached = await getCached(date);
    const id  = makeId(t, s.author, cached?.entries || []);
    const appendment = {
      id, author: s.author, t,
      content: text,
      gps: resolved.gps,
    };
    closeNoteForm();
    if (resolved.mintedCheckin) await commitAdd(date, resolved.mintedCheckin);
    await commitAddAppendment(date, parentId, appendment);
  }
}

async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  // Replace within an edit-photo / edit-appendment-photo flow: keep the
  // composing kind, just swap the file and refresh the preview. GPS isn't
  // re-sampled — the original location anchors the photo.
  if (s.composing?.kind === 'edit-photo' ||
      s.composing?.kind === 'edit-appendment-photo') {
    s.composing.replacedFile = file;
    const prev = $('photo-preview');
    if (prev._url) URL.revokeObjectURL(prev._url);
    prev._url = URL.createObjectURL(file);
    prev.src = prev._url;
    return;
  }

  const t = nowLocalIso();
  // append-photo: parentId was preset by startAddAppendmentPhoto; we layer
  // file + t on top. add-photo (no preset): build from scratch.
  if (s.composing?.kind === 'append-photo') {
    s.composing.file = file;
    s.composing.t = t;
  } else {
    s.composing = { kind: 'add-photo', file, t };
  }

  const prev = $('photo-preview');
  if (prev._url) URL.revokeObjectURL(prev._url);
  prev._url = URL.createObjectURL(file);
  prev.src = prev._url;
  prev.hidden = false;

  // Stash the raw sample on s.composing. The trust check + auto-checkin
  // mint happens at submit time (submitPhoto), so a cancelled add never
  // mints a phantom check-in.
  const sampled = await geoloc.sample({ timeout: 5000, maximumAge: 60000 });
  const sampledNorm = sampled ? { lat: sampled.lat, lon: sampled.lon } : null;
  if (s.composing?.kind === 'add-photo' || s.composing?.kind === 'append-photo') {
    s.composing.gps = sampledNorm;
  }
  const meta = $('photo-preview-meta');
  const gpsLine = sampledNorm
    ? `${sampledNorm.lat.toFixed(5)}, ${sampledNorm.lon.toFixed(5)}`
    : 'GPS unavailable';
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
  const c = s.composing;
  if (!c) return;
  const date = s.viewedDate;
  const btn = $('photo-confirm');
  btn.disabled = true;
  btn.textContent = c.kind === 'add-photo' ? 'Adding…' : 'Saving…';

  if (c.kind === 'add-photo') {
    if (!c.file) return;
    const { file, t, gps } = c;
    const hms  = t.slice(11, 19).replace(/:/g, '');
    const ext  = (file.name?.split('.').pop() || 'jpg').toLowerCase();
    const ref  = `${date}_${hms}_${s.author}.${ext}`;
    const resolved = await resolveGpsAndMaybeCheckin({ date, gps: gps || null, t, author: s.author });
    const cached = await getCached(date);
    const id   = makeId(t, s.author, cached?.entries || []);
    const entry = {
      id, type: 'photo', author: s.author, t,
      ref, comment,
      gps: resolved.gps,
    };
    closePhotoForm();
    if (resolved.mintedCheckin) await commitAdd(date, resolved.mintedCheckin);
    await commitAddPhoto(date, entry, file);
  } else if (c.kind === 'edit-photo') {
    const entryId = c.entryId;
    const replacedFile = c.replacedFile || null;
    closePhotoForm();
    await commitEditPhoto(date, entryId, { comment }, replacedFile);
  } else if (c.kind === 'edit-appendment-photo') {
    const { parentId, appId } = c;
    const replacedFile = c.replacedFile || null;
    closePhotoForm();
    await commitEditAppendmentPhoto(date, parentId, appId, { comment }, replacedFile);
  } else if (c.kind === 'append-photo') {
    if (!c.file || !c.parentId) return;
    const { file, t, gps, parentId } = c;
    const hms  = t.slice(11, 19).replace(/:/g, '');
    const ext  = (file.name?.split('.').pop() || 'jpg').toLowerCase();
    const ref  = `${date}_${hms}_${s.author}.${ext}`;
    const resolved = await resolveGpsAndMaybeCheckin({ date, gps: gps || null, t, author: s.author });
    const cached = await getCached(date);
    const id   = makeId(t, s.author, cached?.entries || []);
    const appendment = {
      id, author: s.author, t,
      ref, comment,
      gps: resolved.gps,
    };
    closePhotoForm();
    if (resolved.mintedCheckin) await commitAdd(date, resolved.mintedCheckin);
    await commitAddAppendmentPhoto(date, parentId, appendment, file);
  }
}

// ─── Edit (start) ─────────────────────────────────────────────────────────────

function startAddAppendmentComment(parentId) {
  s.composing = { kind: 'append-note', parentId };
  $('note-text').value = '';
  $('note-confirm').disabled = true;
  $('note-confirm').textContent = 'Add';
  show('note-form');
  $('note-text').focus();
}

function startAddAppendmentPhoto(parentId) {
  // Stage the parentId on composing; onPhotoSelected reads it after the
  // file picker closes and lays the file/t/gps fields on top.
  s.composing = { kind: 'append-photo', parentId };
  $('photo-input').click();
}

function startEditEntry(entryId) {
  const entry = s.logEntries.find(e => e.id === entryId);
  if (!entry || entry.author !== s.author) return; // D6
  if (entry.type === 'note') {
    s.composing = { kind: 'edit-note', entryId };
    $('note-text').value = entry.content || '';
    $('note-confirm').disabled = false;
    $('note-confirm').textContent = 'Save';
    show('note-form');
    $('note-text').focus();
  } else if (entry.type === 'photo') {
    s.composing = { kind: 'edit-photo', entryId, ref: entry.ref };
    setupPhotoFormForEdit(entry);
  }
}

// Direct-replace shortcut: skip the Edit gate entirely. Set the composing
// kind to edit-photo, prep the photo form (so the Save button is reachable
// after the user picks a file), then trigger the file picker. The detail-
// view handler closes its sheet before dispatching, so the picker overlays
// the log front page. onPhotoSelected sees kind=edit-photo and runs the
// swap path; submitPhoto then commits via commitEditPhoto.
async function startReplaceEntry(entryId) {
  const entry = s.logEntries.find(e => e.id === entryId);
  if (!entry || entry.author !== s.author || entry.type !== 'photo') return;
  s.composing = { kind: 'edit-photo', entryId, ref: entry.ref };
  await setupPhotoFormForEdit(entry);
  $('photo-input').click();
}

async function startReplaceAppendment(parentId, appId) {
  const parent = s.logEntries.find(e => e.id === parentId);
  if (!parent) return;
  const app = (parent.appendments || []).find(a => a.id === appId);
  if (!app || app.author !== s.author || !app.ref) return;
  s.composing = { kind: 'edit-appendment-photo', parentId, appId, ref: app.ref };
  await setupPhotoFormForEdit(app);
  $('photo-input').click();
}

function startEditAppendment(parentId, appId) {
  const parent = s.logEntries.find(e => e.id === parentId);
  if (!parent) return;
  const app = (parent.appendments || []).find(a => a.id === appId);
  if (!app || app.author !== s.author) return; // D6
  if (app.ref) {
    s.composing = { kind: 'edit-appendment-photo', parentId, appId, ref: app.ref };
    setupPhotoFormForEdit(app);
  } else {
    s.composing = { kind: 'edit-appendment-note', parentId, appId };
    $('note-text').value = app.content || '';
    $('note-confirm').disabled = false;
    $('note-confirm').textContent = 'Save';
    show('note-form');
    $('note-text').focus();
  }
}

async function setupPhotoFormForEdit(entryOrApp) {
  $('photo-comment').value = entryOrApp.comment || '';
  $('photo-comment').disabled = false;
  $('photo-confirm').disabled = !(entryOrApp.comment || '').trim();
  $('photo-confirm').textContent = 'Save';

  const prev = $('photo-preview');
  if (prev._url) { URL.revokeObjectURL(prev._url); prev._url = null; }
  prev.removeAttribute('src');
  prev.hidden = true;
  const url = await getLocalUrl(entryOrApp.ref);
  if (url) {
    prev.src = url;
    prev.hidden = false;
  }
  const meta = $('photo-preview-meta');
  const gpsLine = entryOrApp.gps
    ? `${entryOrApp.gps.lat.toFixed(5)}, ${entryOrApp.gps.lon.toFixed(5)}`
    : 'no GPS';
  meta.textContent = `${entryOrApp.ref} · ${gpsLine}`;
  meta.hidden = false;
  $('photo-replace').hidden = false;
  show('photo-form');
}

// ─── Delete (request → confirm → execute) ─────────────────────────────────────

async function deleteEntryRequested(entryId) {
  const entry = s.logEntries.find(e => e.id === entryId);
  if (!entry || entry.type === 'checkin') return;
  const apps = entry.appendments || [];
  const msg = apps.length === 0
    ? `Delete this ${entry.type}?`
    : `Delete this ${entry.type} and ${apps.length} contribution${apps.length === 1 ? '' : 's'} (${formatBreakdown(apps)})?`;
  if (!confirm(msg)) return;
  await commitDeleteEntry(s.viewedDate, entry);
}

async function deleteAppendmentRequested(parentId, appId) {
  const parent = s.logEntries.find(e => e.id === parentId);
  if (!parent) return;
  const app = (parent.appendments || []).find(a => a.id === appId);
  if (!app) return;
  const what = app.ref ? 'photo' : 'comment';
  const msg = app.author === s.author
    ? `Delete your ${what}?`
    : `Delete ${app.author}'s ${what}?`;
  if (!confirm(msg)) return;
  await commitDeleteAppendment(s.viewedDate, parentId, app);
}

async function deleteCheckinGroupRequested(checkinId) {
  const entry = s.logEntries.find(e => e.id === checkinId);
  if (!entry || entry.type !== 'checkin') return;
  const cascadeIds = computeCheckinCascade(checkinId, s.logEntries);
  let msg;
  if (cascadeIds.length === 0) {
    msg = 'Delete this check-in?';
  } else {
    const cascadeItems = s.logEntries.filter(e => cascadeIds.includes(e.id));
    msg = `Delete this check-in and ${cascadeIds.length} entr${cascadeIds.length === 1 ? 'y' : 'ies'} (${formatCheckinBreakdown(cascadeItems)})?`;
  }
  if (!confirm(msg)) return;
  await commitDeleteMany(s.viewedDate, [checkinId, ...cascadeIds]);
}

function formatBreakdown(items) {
  const counts = {};
  for (const it of items) counts[it.author] = (counts[it.author] || 0) + 1;
  return Object.entries(counts)
    .sort()
    .map(([a, c]) => `${c} from ${a}`)
    .join(', ');
}

function formatCheckinBreakdown(items) {
  const otherAuthor = s.author === 'N' ? 'A' : 'N';
  const own   = items.filter(e => e.author === s.author).length;
  const other = items.filter(e => e.author === otherAuthor).length;
  const parts = [];
  if (own > 0)   parts.push(`${own} yours`);
  if (other > 0) parts.push(`${other} from ${otherAuthor}`);
  return parts.join(', ');
}

function computeCheckinCascade(checkinId, entries) {
  const sorted = [...entries].sort(byT);
  const i = sorted.findIndex(e => e.id === checkinId && e.type === 'checkin');
  if (i < 0) return [];
  const next = sorted.slice(i + 1).find(e => e.type === 'checkin');
  const upper = next ? next.t : '￿';
  return sorted
    .filter(e => e.t > sorted[i].t && e.t < upper)
    .map(e => e.id);
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
  // Mark the id as pending-add before the optimistic write so a refresh
  // racing the atomicEdit (or running while the op sits in the queue)
  // preserves it from cache instead of wiping it.
  addPendingAdd(date, entry.id);
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
  addPendingAdd(date, entry.id);
  await applyOptimistic(date, xs => [...xs, entry].sort(byT));

  // Thumb first so the timeline.json never points at a missing file. If the
  // thumb upload fails (non-auth), queue both ops in order — entry can't
  // ship before its thumb does.
  let thumbDirect = false;
  try {
    const { sha } = await putFile(daysPath(`${date}/thumbs/${entry.ref}`), blob,
                                  `Add thumbnail ${entry.ref}`);
    if (sha) await setLocalSha(entry.ref, sha);
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

async function commitAddAppendment(date, parentId, appendment) {
  addPendingAdd(date, appendment.id);
  await applyOptimistic(date, xs => xs.map(e => {
    if (e.id !== parentId) return e;
    return {
      ...e,
      appendments: [...(e.appendments || []), appendment].sort(byT),
    };
  }));
  try {
    await addAppendment(date, parentId, appendment);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'add-appendment', date, args: { parentId, appendment } });
  }
}

async function commitAddAppendmentPhoto(date, parentId, appendment, file) {
  const blob = await generateFromFile(file);
  await storeLocal(appendment.ref, blob);
  addPendingAdd(date, appendment.id);
  await applyOptimistic(date, xs => xs.map(e => {
    if (e.id !== parentId) return e;
    return {
      ...e,
      appendments: [...(e.appendments || []), appendment].sort(byT),
    };
  }));

  let thumbDirect = false;
  try {
    const { sha } = await putFile(daysPath(`${date}/thumbs/${appendment.ref}`), blob,
                                  `Add thumbnail ${appendment.ref}`);
    if (sha) await setLocalSha(appendment.ref, sha);
    thumbDirect = true;
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'put-thumb', date, args: { ref: appendment.ref } });
  }

  if (!thumbDirect) {
    await ops.enqueue({ kind: 'add-appendment', date, args: { parentId, appendment } });
    return;
  }
  try {
    await addAppendment(date, parentId, appendment);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'add-appendment', date, args: { parentId, appendment } });
  }
}

async function commitEdit(date, id, patch) {
  await applyOptimistic(date, xs =>
    xs.map(e => e.id === id ? { ...e, ...patch } : e),
  );
  try {
    await editEntry(date, id, patch);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'edit-entry', date, args: { id, patch } });
  }
}

async function commitEditAppendment(date, parentId, appId, patch) {
  await applyOptimistic(date, xs => xs.map(e => {
    if (e.id !== parentId) return e;
    return {
      ...e,
      appendments: (e.appendments || []).map(a =>
        a.id === appId ? { ...a, ...patch } : a,
      ),
    };
  }));
  try {
    await editAppendment(date, parentId, appId, patch);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'edit-appendment', date, args: { parentId, appId, patch } });
  }
}

async function commitEditPhoto(date, id, patch, replacedFile) {
  let mergedPatch = patch;
  let oldRef = null;
  if (replacedFile) {
    const entry = s.logEntries.find(e => e.id === id);
    if (entry) {
      oldRef = entry.ref || null;
      const swap = await prepareReplacedSource(date, entry, replacedFile);
      if (swap.error) { alert(swap.error); return; }
      // sourcePath: null — phone Replace pulls from the camera roll, which
      // is not the laptop's /photo-source mount. Any prior sourcePath
      // (from a previous laptop Replace/Add) is now stale and must be
      // cleared, otherwise the laptop's matchStatus reports a false ✓
      // matched against an unrelated PC file.
      mergedPatch = { ...patch, ref: swap.newRef, t: swap.newT, gps: swap.gps, sourcePath: null };
    }
  }
  await commitEdit(date, id, mergedPatch);
  if (oldRef && mergedPatch.ref && oldRef !== mergedPatch.ref) {
    await cleanupOldThumb(date, oldRef);
  }
}

async function commitEditAppendmentPhoto(date, parentId, appId, patch, replacedFile) {
  let mergedPatch = patch;
  let oldRef = null;
  if (replacedFile) {
    const parent = s.logEntries.find(e => e.id === parentId);
    const app = parent?.appendments?.find(a => a.id === appId);
    if (app) {
      oldRef = app.ref || null;
      const swap = await prepareReplacedSource(date, app, replacedFile);
      if (swap.error) { alert(swap.error); return; }
      // sourcePath: null — phone Replace pulls from the camera roll, which
      // is not the laptop's /photo-source mount. Any prior sourcePath
      // (from a previous laptop Replace/Add) is now stale and must be
      // cleared, otherwise the laptop's matchStatus reports a false ✓
      // matched against an unrelated PC file.
      mergedPatch = { ...patch, ref: swap.newRef, t: swap.newT, gps: swap.gps, sourcePath: null };
    }
  }
  await commitEditAppendment(date, parentId, appId, mergedPatch);
  if (oldRef && mergedPatch.ref && oldRef !== mergedPatch.ref) {
    await cleanupOldThumb(date, oldRef);
  }
}

// Cross-date Replace is rejected — moves across days are explicit
// delete-and-add. EXIF date != entry's day fires the same 409-equivalent on
// the phone as on the laptop.
async function prepareReplacedSource(date, entry, file) {
  const meta = await extractMeta(file);
  const noExif = !meta.t;
  if (meta.date && meta.date !== date) {
    return { error: `Source EXIF date ${meta.date} doesn't match this day's ${date}.` };
  }

  const newT = meta.t || nowLocalIso();
  const author = entry.author || s.author;
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
  const newRef = composeRef({ date, author, t: newT, sourceFilename: file.name || '', noExif, ext });

  const blob = await generateFromFile(file);
  await storeLocal(newRef, blob);
  try {
    const { sha } = await putFile(daysPath(`${date}/thumbs/${newRef}`), blob, `Replace thumbnail → ${newRef}`);
    if (sha) await setLocalSha(newRef, sha);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'put-thumb', date, args: { ref: newRef } });
  }

  return { newRef, newT, gps: meta.gps || null };
}

function composeRef({ date, author, t, sourceFilename, noExif, ext }) {
  if (!noExif && t) {
    const hms = t.slice(11, 19).replace(/:/g, '');
    return `${date}_${hms}_${author}.${ext}`;
  }
  // No-EXIF fallback: sanitized source basename. Keeps the date prefix so the
  // ref still sorts and reads naturally alongside EXIF-derived refs.
  const stem = (sourceFilename.replace(/\.[^.]*$/, '') || 'photo')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'photo';
  return `${date}_${stem}_${author}.${ext}`;
}

async function cleanupOldThumb(date, oldRef) {
  await deleteLocal(oldRef);
  try {
    await deleteFile(daysPath(`${date}/thumbs/${oldRef}`), `Remove old thumbnail ${oldRef}`);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'delete-thumb', date, args: { ref: oldRef } });
  }
}

async function commitDeleteEntry(date, entry) {
  const refSink = collectRefs(entry);
  // Tombstone before optimistic update so a racing refresh can't bring
  // the entry back if it fetches the remote before atomicEdit's PUT lands.
  addTombstone(date, entry.id);
  for (const a of entry.appendments || []) addTombstone(date, a.id);
  await applyOptimistic(date, xs => xs.filter(e => e.id !== entry.id));
  try {
    await deleteEntry(date, entry.id, []);
    await cleanupThumbs(date, refSink);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'delete-entry', date, args: { id: entry.id } });
    queueThumbCleanup(date, refSink);
  }
}

async function commitDeleteAppendment(date, parentId, app) {
  const refSink = app.ref ? [app.ref] : [];
  addTombstone(date, app.id);
  await applyOptimistic(date, xs => xs.map(e => {
    if (e.id !== parentId) return e;
    return { ...e, appendments: (e.appendments || []).filter(a => a.id !== app.id) };
  }));
  try {
    await deleteAppendment(date, parentId, app.id, []);
    await cleanupThumbs(date, refSink);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'delete-appendment', date, args: { parentId, appId: app.id } });
    queueThumbCleanup(date, refSink);
  }
}

async function commitDeleteMany(date, ids) {
  const idSet = new Set(ids);
  const cached = await getCached(date);
  const refSink = [];
  for (const e of cached?.entries || []) {
    if (!idSet.has(e.id)) continue;
    if (e.ref) refSink.push(e.ref);
    for (const a of e.appendments || []) if (a.ref) refSink.push(a.ref);
  }
  for (const id of ids) addTombstone(date, id);
  await applyOptimistic(date, xs => xs.filter(e => !idSet.has(e.id)));
  try {
    await deleteMany(date, ids, []);
    await cleanupThumbs(date, refSink);
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    await ops.enqueue({ kind: 'delete-many', date, args: { ids } });
    queueThumbCleanup(date, refSink);
  }
}

function collectRefs(entry) {
  const refs = [];
  if (entry.ref) refs.push(entry.ref);
  for (const a of entry.appendments || []) if (a.ref) refs.push(a.ref);
  return refs;
}

// Online cleanup: for each ref, drop the local blob then fetch the remote
// sha and DELETE the file. Failures are swallowed (D10 — orphan thumbs are
// harmless) but auth errors short-circuit so the user can fix settings.
async function cleanupThumbs(date, refs) {
  for (const ref of refs) {
    deleteLocal(ref).catch(() => {});
    try {
      const { sha } = await getBinary(daysPath(`${date}/thumbs/${ref}`), 'image/jpeg');
      await deleteFile(daysPath(`${date}/thumbs/${ref}`), sha, `Delete thumbnail ${ref}`);
    } catch (e) {
      if (e instanceof GitHubAuthError) return;
      if (e instanceof GitHubNotFoundError) continue;
      // network or other — best-effort, swallow
    }
  }
}

// Offline cleanup: drop the local blob and queue a remote DELETE op for
// when the network returns. Order matters less here than for adds — the
// timeline mutation already removed the reference, the thumb is now an
// orphan and can be deleted whenever.
function queueThumbCleanup(date, refs) {
  for (const ref of refs) {
    deleteLocal(ref).catch(() => {});
    ops.enqueue({ kind: 'delete-thumb', date, args: { ref } }).catch(() => {});
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

