// Entry detail view (Phase 5).
//
// Tap any entry in the log → this full-screen sheet opens showing the parent
// entry, then any appendments, then a sticky bottom action bar. Step 7
// scaffolds the rendering only; the parent / appendment Edit + Delete
// buttons and the bottom + Comment / + Photo buttons are placeholders that
// Steps 8 and 9 wire up.
//
// The sheet re-renders on 'day-changed' so live cross-device edits land
// while it's open. If the viewed entry disappears from the cache (deleted
// by the other device), the sheet closes itself.

import { $, esc, show, hide } from '../../core/ui.js';
import { s } from '../../core/state.js';
import * as thumbs from '../../services/thumbs.js';
import { getCached } from '../../services/timeline.js';
import { AUTHOR_COLORS } from './log-ui.js';

const TYPE_LABELS = { checkin: 'Check-in', note: 'Note', photo: 'Photo' };

export function setupDetailView() {
  $('entry-detail-close').addEventListener('click', closeDetail);

  // Tap-to-open dispatched by log-ui.js — we don't import log-ui beyond the
  // colour map, so the event keeps the dependency one-way.
  window.addEventListener('entry-detail-open', e => openDetail(e.detail.id));

  // Action bar (parent) — Edit / Delete / Delete-checkin (Step 8).
  $('entry-detail-actions').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const entryId = s.viewingEntry;
    if (!entryId) return;
    const action = btn.dataset.action;
    if (action === 'edit') {
      closeDetail();
      window.dispatchEvent(new CustomEvent('entry-edit-requested', { detail: { id: entryId } }));
    } else if (action === 'replace') {
      closeDetail();
      window.dispatchEvent(new CustomEvent('entry-replace-requested', { detail: { id: entryId } }));
    } else if (action === 'delete') {
      window.dispatchEvent(new CustomEvent('entry-delete-requested', { detail: { id: entryId } }));
    } else if (action === 'delete-checkin') {
      window.dispatchEvent(new CustomEvent('checkin-delete-requested', { detail: { id: entryId } }));
    }
  });

  // Per-appendment Edit / Delete (Step 8) and the bottom-bar add buttons
  // (Step 9 wires +Comment / +Photo).
  $('entry-detail-appendments').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const appId = btn.dataset.appId;
    if (!appId || !s.viewingEntry) return;
    const parentId = s.viewingEntry;
    const action = btn.dataset.action;
    if (action === 'edit-app') {
      closeDetail();
      window.dispatchEvent(new CustomEvent('appendment-edit-requested', { detail: { parentId, appId } }));
    } else if (action === 'replace-app') {
      closeDetail();
      window.dispatchEvent(new CustomEvent('appendment-replace-requested', { detail: { parentId, appId } }));
    } else if (action === 'delete-app') {
      window.dispatchEvent(new CustomEvent('appendment-delete-requested', { detail: { parentId, appId } }));
    }
  });

  // Bottom action bar — + Comment / + Photo (Step 9). Both close the sheet
  // and dispatch — log.js opens the form prefilled with the parentId.
  $('entry-detail-add-comment').addEventListener('click', () => {
    if (!s.viewingEntry) return;
    const parentId = s.viewingEntry;
    closeDetail();
    window.dispatchEvent(new CustomEvent('appendment-add-comment-requested', { detail: { parentId } }));
  });
  $('entry-detail-add-photo').addEventListener('click', () => {
    if (!s.viewingEntry) return;
    const parentId = s.viewingEntry;
    closeDetail();
    window.dispatchEvent(new CustomEvent('appendment-add-photo-requested', { detail: { parentId } }));
  });

  // Read cache directly — log.js's parallel day-changed listener kicks
  // off loadLog asynchronously, so s.logEntries is still stale at the
  // moment our handler runs and would falsely report the just-deleted
  // entry as "still exists".
  window.addEventListener('day-changed', async e => {
    if (e.detail?.date !== s.viewedDate || !s.viewingEntry) return;
    const cached = await getCached(s.viewedDate);
    const entries = cached?.entries || [];
    const stillExists = entries.some(x => x.id === s.viewingEntry);
    if (!stillExists) { closeDetail(); return; }
    renderDetail();
  });
}

function openDetail(entryId) {
  s.viewingEntry = entryId;
  show('entry-detail');
  renderDetail();
}

function closeDetail() {
  hide('entry-detail');
  s.viewingEntry = null;
}

async function renderDetail() {
  if (!s.viewingEntry) return;
  // Same staleness reason as the day-changed handler — read cache.
  const cached = await getCached(s.viewedDate);
  const entries = cached?.entries || s.logEntries;
  const entry = entries.find(e => e.id === s.viewingEntry);
  if (!entry) { closeDetail(); return; }

  const time = (entry.t || '').slice(11, 16);
  // Check-ins show their time prominently on the log front page (they're
  // the trip's location heartbeat); for notes/photos the time is hidden on
  // the front and surfaced here as "added HH:MM".
  const timeLabel = entry.type === 'checkin' ? time : `added ${time}`;
  $('entry-detail-title').textContent =
    `${TYPE_LABELS[entry.type] || entry.type} · ${timeLabel} · ${entry.author}`;

  $('entry-detail-parent').innerHTML      = await parentHtml(entry);
  $('entry-detail-actions').innerHTML     = parentActionsHtml(entry);
  $('entry-detail-appendments').innerHTML = await appendmentsHtml(entry.appendments || []);
}

async function parentHtml(entry) {
  const c = AUTHOR_COLORS[entry.author] || { tint: '#f5f5f5' };
  const locTag = entry.gps ? '<div class="entry-detail-loc">Location ✓</div>' : '';

  let body;
  if (entry.type === 'photo') {
    const url = entry.ref ? await thumbs.getLocalUrl(entry.ref) : null;
    const img = url
      ? `<img class="entry-detail-photo" src="${url}" alt="">`
      : '<div class="entry-detail-photo-placeholder">📷</div>';
    const comment = entry.comment ? `<p class="entry-detail-comment">${esc(entry.comment)}</p>` : '';
    body = `${img}${comment}`;
  } else if (entry.type === 'note') {
    body = `<p class="entry-detail-content">${esc(entry.content || '')}</p>`;
  } else {
    body = '<p class="entry-detail-checkin">📍 Checked in</p>';
  }
  return `<div class="entry-detail-card" style="background:${c.tint}">${body}${locTag}</div>`;
}

function parentActionsHtml(entry) {
  // D6: only the original author can edit (and check-ins aren't editable —
  // GPS auto-sets, no content/comment to change). D7: either author can
  // delete; check-in deletes cascade through the next-checkin window.
  // Replace is a top-level shortcut on photo entries — opens the file
  // picker directly so swapping a photo doesn't require Edit-then-Replace.
  const isOwn = entry.author === s.author;
  const editable = entry.type !== 'checkin';
  const replaceBtn = (isOwn && entry.type === 'photo')
    ? '<button class="entry-detail-action-replace" data-action="replace">Replace</button>'
    : '';
  const editBtn = (isOwn && editable)
    ? '<button class="entry-detail-action-edit" data-action="edit">Edit</button>'
    : '';
  const isCheckin = entry.type === 'checkin';
  const deleteBtn = `<button class="entry-detail-action-delete" data-action="${isCheckin ? 'delete-checkin' : 'delete'}">Delete</button>`;
  return `${replaceBtn}${editBtn}${deleteBtn}`;
}

async function appendmentsHtml(apps) {
  if (!apps.length) {
    return '<p class="entry-detail-no-apps">No contributions yet.</p>';
  }
  let html = '';
  for (const app of apps) html += await singleAppendmentHtml(app);
  return html;
}

async function singleAppendmentHtml(app) {
  const c = AUTHOR_COLORS[app.author] || { tint: '', badge: '#999' };
  const time = (app.t || '').slice(11, 16);
  const isOwn = app.author === s.author;

  let body;
  if (app.ref) {
    const url = await thumbs.getLocalUrl(app.ref);
    const img = url
      ? `<img class="appendment-photo" src="${url}" alt="">`
      : '<span class="photo-icon">📷</span>';
    const comment = app.comment ? `<p class="appendment-comment">${esc(app.comment)}</p>` : '';
    body = `${img}${comment}`;
  } else {
    body = `<p class="appendment-content">${esc(app.content || '')}</p>`;
  }

  // Replace shortcut on photo appendments only — same rationale as the
  // parent-level Replace: open the file picker directly without an Edit gate.
  const replaceBtn = (isOwn && app.ref)
    ? `<button data-action="replace-app" data-app-id="${esc(app.id)}">Replace</button>`
    : '';
  const editBtn = isOwn
    ? `<button data-action="edit-app" data-app-id="${esc(app.id)}">Edit</button>`
    : '';
  const deleteBtn = `<button data-action="delete-app" data-app-id="${esc(app.id)}">Delete</button>`;

  return `<div class="appendment" style="background:${c.tint}" data-app-id="${esc(app.id)}">
    <span class="author-badge" style="background:${c.badge};color:#fff">${app.author}</span>
    <span class="appendment-time">added ${time}</span>
    <div class="appendment-body">${body}</div>
    <div class="appendment-actions">${replaceBtn}${editBtn}${deleteBtn}</div>
  </div>`;
}
