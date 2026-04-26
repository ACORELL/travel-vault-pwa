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
import { AUTHOR_COLORS } from './log-ui.js';

const TYPE_LABELS = { checkin: 'Check-in', note: 'Note', photo: 'Photo' };

export function setupDetailView() {
  $('entry-detail-close').addEventListener('click', closeDetail);

  // Tap-to-open dispatched by log-ui.js — we don't import log-ui beyond the
  // colour map, so the event keeps the dependency one-way.
  window.addEventListener('entry-detail-open', e => openDetail(e.detail.id));

  window.addEventListener('day-changed', e => {
    if (e.detail?.date !== s.viewedDate || !s.viewingEntry) return;
    const stillExists = s.logEntries.some(x => x.id === s.viewingEntry);
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
  const entry = s.logEntries.find(e => e.id === s.viewingEntry);
  if (!entry) return;

  const time = (entry.t || '').slice(11, 16);
  $('entry-detail-title').textContent =
    `${TYPE_LABELS[entry.type] || entry.type} · ${time} · ${entry.author}`;

  $('entry-detail-parent').innerHTML      = await parentHtml(entry);
  $('entry-detail-actions').innerHTML     = parentActionsHtml(entry);
  $('entry-detail-appendments').innerHTML = await appendmentsHtml(entry.appendments || []);
}

async function parentHtml(entry) {
  const c = AUTHOR_COLORS[entry.author] || { tint: '#f5f5f5' };
  const locTag = entry.gps ? '<div class="entry-detail-loc">Location ✓</div>' : '';

  let body;
  if (entry.type === 'photo') {
    const isOwn = entry.author === s.author;
    const url = isOwn && entry.ref ? await thumbs.getLocalUrl(entry.ref) : null;
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
  // D6: only the original author can edit. D7: either author can delete.
  // Buttons are disabled placeholders here; Step 8 enables and wires them.
  const isOwn = entry.author === s.author;
  const editBtn = isOwn
    ? '<button class="entry-detail-action-edit" data-action="edit" disabled>Edit</button>'
    : '';
  const deleteBtn = '<button class="entry-detail-action-delete" data-action="delete" disabled>Delete</button>';
  return `${editBtn}${deleteBtn}`;
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
    const url = isOwn ? await thumbs.getLocalUrl(app.ref) : null;
    const img = url
      ? `<img class="appendment-photo" src="${url}" alt="">`
      : '<span class="photo-icon">📷</span>';
    const comment = app.comment ? `<p class="appendment-comment">${esc(app.comment)}</p>` : '';
    body = `${img}${comment}`;
  } else {
    body = `<p class="appendment-content">${esc(app.content || '')}</p>`;
  }

  const editBtn = isOwn
    ? `<button data-action="edit-app" data-app-id="${esc(app.id)}" disabled>Edit</button>`
    : '';
  const deleteBtn = `<button data-action="delete-app" data-app-id="${esc(app.id)}" disabled>Delete</button>`;

  return `<div class="appendment" style="background:${c.tint}" data-app-id="${esc(app.id)}">
    <span class="author-badge" style="background:${c.badge};color:#fff">${app.author}</span>
    <span class="appendment-time">${time}</span>
    <div class="appendment-body">${body}</div>
    <div class="appendment-actions">${editBtn}${deleteBtn}</div>
  </div>`;
}
