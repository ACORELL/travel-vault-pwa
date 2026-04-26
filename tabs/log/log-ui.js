// Log tab — rendering, day-nav UI state, pending-draft toggles, and the
// inline OSM check-in map.
//
// Phase 4: own photos render via thumbs.getLocalUrl from local IDB. Other-
// author photo entries (added by step 5's getCombined) render as text
// placeholders since their thumbnails live in the data repo and aren't
// fetched mid-day.
import { $, esc, fmtDate } from '../../core/ui.js';
import { s, TODAY } from '../../core/state.js';
import * as thumbs from '../../services/thumbs.js';

const AUTHOR_COLORS = {
  N: { base: '#f9e4ec', tint: 'rgba(249,228,236,0.35)', badge: '#c2185b' },
  A: { base: '#e4eef9', tint: 'rgba(228,238,249,0.35)', badge: '#1565c0' },
};

function entryHHMM(entry) {
  return (entry.t || '').slice(11, 16);
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
    const timeEl = `<span class="entry-time">${entryHHMM(entry)}</span>`;
    const ec = AUTHOR_COLORS[entry.author] || { base: '#f5f5f5', tint: 'rgba(245,245,245,0.35)', badge: '#999' };

    if (entry.type === 'checkin') {
      groupAuthor = entry.author;
      li.className = 'log-entry checkin';
      li.style.background = ec.base;
      const badgeHtml = `<span class="author-badge" style="background:${ec.badge};color:#fff">${entry.author}</span>`;
      const locationHtml = entry.gps
        ? `${checkinMapHtml(entry.gps.lat, entry.gps.lon)}<span class="checkin-coords">${entry.gps.lat.toFixed(5)}, ${entry.gps.lon.toFixed(5)}</span>`
        : '<span class="checkin-no-gps">Location unavailable</span>';
      li.innerHTML = `${badgeHtml}${timeEl}<div class="entry-body">
        <span class="checkin-label">📍 Checked in</span>${locationHtml}
      </div>`;
    } else {
      li.className = 'log-entry';
      if (groupAuthor) {
        li.style.background = AUTHOR_COLORS[groupAuthor]?.tint || '';
      }

      if (entry.type === 'photo') {
        const isOwn = entry.author === s.author;
        let thumb = '';
        if (isOwn && entry.ref) {
          const url = await thumbs.getLocalUrl(entry.ref);
          if (url) thumb = `<img class="entry-thumb" src="${url}" alt="">`;
        }
        if (!thumb) thumb = '<span class="photo-icon">📷</span>';
        li.innerHTML = `${timeEl}<div class="entry-body">
          <div class="entry-photo-wrap">${thumb}</div>
          <p class="entry-comment">${esc(entry.comment || '')}</p>
        </div>`;
      } else {
        // type === 'note'
        li.innerHTML = `${timeEl}<div class="entry-body">${esc(entry.content || '')}</div>`;
      }
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

export function showPendingDraft(previewText) {
  $('pending-preview').textContent = previewText;
  $('add-bar').style.display = 'none';
  $('add-bar-hint').style.display = 'none';
  $('pending-draft').style.display = 'block';
}

export function hidePendingDraft() {
  s.pendingDraft = null;
  $('pending-draft').style.display = 'none';
  $('add-bar').style.display = '';
  updateActionBarState();
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
