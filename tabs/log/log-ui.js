// Log tab UI — render the shared timeline (Phase 5).
//
// One LI per parent entry, with appendments rendered inline below the parent
// (one level deep, D5). Every entry is tappable; the click-handler is wired
// in Step 7 once the detail-view sheet exists. Own photos render via
// thumbs.getLocalUrl; other-author photos render as a 📷 icon until
// restoreFromRepo or a future fetch hydrates the local thumb cache.

import { $, esc, fmtDate } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import * as thumbs from '../../services/thumbs.js';

export const AUTHOR_COLORS = {
  N: { base: '#f9e4ec', tint: 'rgba(249,228,236,0.35)', badge: '#c2185b' },
  A: { base: '#e4eef9', tint: 'rgba(228,238,249,0.35)', badge: '#1565c0' },
};

function entryHHMM(entry) {
  return (entry.t || '').slice(11, 16);
}

function authorColor(author) {
  return AUTHOR_COLORS[author] || { base: '#f5f5f5', tint: 'rgba(245,245,245,0.35)', badge: '#999' };
}

function authorBadgeHtml(author) {
  const c = authorColor(author);
  return `<span class="author-badge" style="background:${c.badge};color:#fff">${author}</span>`;
}

async function thumbHtml(ref, isOwn) {
  if (isOwn && ref) {
    const url = await thumbs.getLocalUrl(ref);
    if (url) return `<img class="entry-thumb" src="${url}" alt="">`;
  }
  return '<span class="photo-icon">📷</span>';
}

async function appendmentHtml(app) {
  const c = authorColor(app.author);
  const time = (app.t || '').slice(11, 16);
  let body;
  if (app.ref) {
    const isOwn = app.author === s.author;
    const thumb = await thumbHtml(app.ref, isOwn);
    body = `<div class="appendment-photo-wrap">${thumb}</div>` +
           (app.comment ? `<p class="appendment-comment">${esc(app.comment)}</p>` : '');
  } else {
    body = `<p class="appendment-content">${esc(app.content || '')}</p>`;
  }
  return `<div class="appendment" style="background:${c.tint}" data-app-id="${esc(app.id)}">
    ${authorBadgeHtml(app.author)}
    <span class="appendment-time">${time}</span>
    <div class="appendment-body">${body}</div>
  </div>`;
}

export async function renderLog() {
  const list = $('log-list');
  if (!s.logEntries.length) {
    const msg = s.viewedDate === TODAY ? 'No entries yet' : 'No entries for this day';
    list.innerHTML = `<li class="empty-state">${msg}</li>`;
    return;
  }
  list.innerHTML = '';

  let groupAuthor = null;

  for (const entry of s.logEntries) {
    const li = document.createElement('li');
    li.dataset.entryId = entry.id;
    const ec = authorColor(entry.author);
    const timeEl = `<span class="entry-time">${entryHHMM(entry)}</span>`;
    const locTag = entry.gps ? '<span class="entry-loc">Location ✓</span>' : '';

    if (entry.type === 'checkin') {
      groupAuthor = entry.author;
      li.className = 'log-entry checkin';
      li.style.background = ec.base;
      const locationHtml = entry.gps
        ? `${checkinMapHtml(entry.gps.lat, entry.gps.lon)}${locTag}`
        : '<span class="checkin-no-gps">Location unavailable</span>';
      li.innerHTML = `${authorBadgeHtml(entry.author)}${timeEl}<div class="entry-body">
        <span class="checkin-label">📍 Checked in</span>${locationHtml}
      </div>`;
    } else {
      li.className = 'log-entry';
      if (groupAuthor) li.style.background = authorColor(groupAuthor).tint;
      let body;
      if (entry.type === 'photo') {
        const isOwn = entry.author === s.author;
        const thumb = await thumbHtml(entry.ref, isOwn);
        body = `<div class="entry-photo-wrap">${thumb}</div>
          <p class="entry-comment">${esc(entry.comment || '')}</p>
          ${locTag}`;
      } else {
        body = `${esc(entry.content || '')}${locTag ? `<br>${locTag}` : ''}`;
      }
      li.innerHTML = `${timeEl}<div class="entry-body">${body}</div>`;
    }

    const apps = entry.appendments || [];
    if (apps.length) {
      const appsBox = document.createElement('div');
      appsBox.className = 'entry-appendments';
      let appsInner = '';
      for (const app of apps) appsInner += await appendmentHtml(app);
      appsBox.innerHTML = appsInner;
      li.appendChild(appsBox);
    }

    list.appendChild(li);
  }
}

export function updateDayNavUI() {
  const idx = s.availableDays.indexOf(s.viewedDate);
  $('day-nav-label').textContent = s.viewedDate === TODAY ? 'Today' : fmtDate(s.viewedDate);
  $('day-prev').disabled = idx <= 0;
  $('day-next').disabled = idx < 0 || idx >= s.availableDays.length - 1;
}

export function updateActionBarState() {
  const isToday = s.viewedDate === TODAY;
  const hasCheckin = s.logEntries.some(e => e.type === 'checkin');
  const hint = $('add-bar-hint');

  if (!isToday) {
    $('btn-checkin').disabled = true;
    $('btn-add-note').disabled = true;
    $('btn-add-photo').disabled = true;
    hint.textContent = 'Past day — read only';
    hint.style.display = 'block';
  } else {
    $('btn-checkin').disabled = false;
    $('btn-add-note').disabled = !hasCheckin;
    $('btn-add-photo').disabled = !hasCheckin;
    if (hasCheckin) {
      hint.textContent = '';
      hint.style.display = 'none';
    } else {
      hint.textContent = 'Check in first to add notes and photos';
      hint.style.display = 'block';
    }
  }
}

function checkinMapHtml(lat, lon) {
  const zoom = 15;
  const n = 1 << zoom;
  const xt = (lon + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(xt), ty = Math.floor(yt);
  const fx = xt - tx, fy = yt - ty;
  const cw = 200, ch = 120;
  const l0 = Math.round(cw / 2 - fx * 256);
  const t0 = Math.round(ch / 2 - fy * 256);
  const grid = [
    [tx,   ty,   l0,       t0      ],
    [tx+1, ty,   l0 + 256, t0      ],
    [tx,   ty+1, l0,       t0 + 256],
    [tx+1, ty+1, l0 + 256, t0 + 256],
  ];
  const imgs = grid.map(([x, y, l, t]) =>
    `<img src="https://tile.openstreetmap.org/${zoom}/${x}/${y}.png" class="checkin-map-tile" style="left:${l}px;top:${t}px" alt="" crossorigin="anonymous">`
  ).join('');
  return `<div class="checkin-map-wrap">${imgs}<div class="checkin-map-pin">📍</div></div>`;
}
