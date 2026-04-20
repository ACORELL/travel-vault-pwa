import { saveVaultHandle, getVaultHandle, enqueueLogEntry, getLogQueue, clearLogKeys } from './db.js';
import * as vault from './vault.js';

// ---- Constants ----
const TODAY = new Date().toISOString().slice(0, 10);

const CHECKIN_PROXIMITY_THRESHOLD_M = 400;

const AUTHOR_COLORS = {
  N: { base: '#f9e4ec', tint: 'rgba(249,228,236,0.35)', badge: '#c2185b' },
  A: { base: '#e4eef9', tint: 'rgba(228,238,249,0.35)', badge: '#1565c0' },
};

// ---- State ----
const s = {
  author:        localStorage.getItem('tv-author'),
  vault:         null,
  syncStatus:    'offline',
  logEntries:    [],
  wikiPages:     [],
  pendingPhoto:  null,   // { file, ts }
  pendingDraft:  null,   // { type: 'note'|'photo', text?, file?, ts?, comment? }
  viewedDate:    TODAY,
  availableDays: [],
};

// ---- Boot ----
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js?v=14').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
  if (navigator.storage?.persist) {
    navigator.storage.persist().then(granted => {
      console.log('[TV] storage.persist granted:', granted);
      if (!granted) console.warn('[TV] IndexedDB may be evicted under storage pressure — vault handle could be lost on cold start.');
    }).catch(() => {});
  }

  // Step 1: author selection — first launch only
  if (!s.author) {
    show('setup-overlay');
    $$('.author-btn').forEach(btn => btn.addEventListener('click', async () => {
      s.author = btn.dataset.initial;
      localStorage.setItem('tv-author', s.author);
      hide('setup-overlay');
      let saved = null;
      try { saved = await getVaultHandle(); } catch {}
      if (saved) { show('app'); startApp(saved); }
      else        { show('vault-setup-overlay'); }
    }));
    return;
  }

  // Author known — ensure overlay is hidden, check for a stored vault handle.
  hide('setup-overlay');
  let saved = null;
  try { saved = await getVaultHandle(); } catch {}
  if (saved) {
    show('app');
    startApp(saved);
  } else {
    show('vault-setup-overlay');
  }
}

async function resetApp() {
  localStorage.clear();
  try { indexedDB.deleteDatabase('travel-vault'); } catch {}
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(regs.map(r => r.unregister()));
  }
  window.location.reload();
}

// First-time vault folder selection
$('pick-vault-btn').addEventListener('click', async () => {
  try {
    const handle = await vault.pickVaultFolder();
    if (!await vault.isVaultRoot(handle)) {
      $('vault-setup-error').textContent = 'Wrong folder — please select the Travel Vault root (it contains trip.md).';
      return;
    }
    await saveVaultHandle(handle);
    hide('vault-setup-overlay');
    show('app');
    startApp(handle);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Vault picker error:', e);
      $('vault-setup-error').textContent = e.message || 'Could not access folder — please try again.';
    }
  }
});

async function startApp(handle) {
  $('date-label').textContent   = fmtDate(TODAY);
  $('author-label').textContent = s.author;

  const perm = await vault.queryPermission(handle);
  if (perm === 'granted') {
    s.vault = handle;
    setSyncStatus('synced');
  } else {
    showBanner();
  }

  setupTabs();
  setupLogTab();
  setupWikiTab();

  await loadAvailableDays();
  await loadLog();
  if (s.vault) {
    await syncQueue();
    await loadWiki();
    await checkConflicts();
  }
}

$('reconnect-btn').addEventListener('click', async () => {
  const handle = await getVaultHandle();
  if (!handle) return;
  const ok = await vault.requestPermission(handle);
  if (ok) {
    s.vault = handle;
    hideBanner('vault-banner');
    setSyncStatus('syncing');
    await syncQueue();
    await loadAvailableDays();
    await loadLog();
    await loadWiki();
    await checkConflicts();
    setSyncStatus('synced');
  }
});

$('conflict-dismiss').addEventListener('click', () => hideBanner('conflict-banner'));

// ---- Queue flush ----
async function syncQueue() {
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

// ---- Log tab ----
function setupLogTab() {
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
  let gps = null;

  if (navigator.geolocation) {
    gps = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        ()  => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  const gpsPart = gps ? ` | ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  await writeLogLine(`${time} | ${s.author} | 📍${gpsPart}`);

  // If a draft was pending proximity check, auto-submit it now under this new check-in
  const draft = s.pendingDraft;
  if (draft) {
    hidePendingDraft();         // clears s.pendingDraft, restores add-bar
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

  const proximity = await checkProximity();

  btn.textContent = 'Add';

  // If the user cancelled the form while GPS was resolving, discard silently
  if ($('note-form').classList.contains('hidden')) return;

  if (proximity === 'out-of-range') {
    hide('note-form');
    $('note-text').value = '';
    s.pendingDraft = { type: 'note', text };
    showPendingDraft(text);
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
  prev.src = URL.createObjectURL(file);
  prev.style.display = 'block';
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
  if (prev.src) URL.revokeObjectURL(prev.src);
  prev.src = '';
  prev.style.display = 'none';
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

  const proximity = await checkProximity();

  btn.textContent = 'Add';

  // If the user cancelled the form while GPS was resolving, discard silently
  if ($('photo-form').classList.contains('hidden')) {
    s.pendingPhoto = null;
    return;
  }

  if (proximity === 'out-of-range') {
    s.pendingPhoto = null;
    cancelPhotoForm();
    s.pendingDraft = { type: 'photo', file, ts, comment };
    showPendingDraft(`📷 "${comment}"`);
    return;
  }

  s.pendingPhoto = null;
  cancelPhotoForm();
  await finishPhotoWrite(file, ts, comment);
  await loadLog();
}

async function finishPhotoWrite(file, ts, comment) {
  const hms  = ts.replace(/:/g, '-');
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const base = `${hms}_${s.author}`;
  const name = await resolvePhotoName(base, ext);
  const time = ts.slice(0, 5);
  const line = `${time} | ${s.author} | 📷 ${name} | "${comment}"`;

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

async function loadLog() {
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
  updateDayNavUI();
  updateActionBarState();
  renderLog();
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
    const m = body.match(/📷\s*(\S+)\s*\|\s*"?(.+?)"?\s*$/);
    return m ? { time: time.trim(), author: author.trim(), type: 'photo', photo: m[1], comment: m[2] }
             : { time: time.trim(), author: author.trim(), type: 'photo', photo: '', comment: '' };
  }
  return { time: time.trim(), author: author.trim(), type: 'text', text: body };
}

async function renderLog() {
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
    const timeEl = `<span class="entry-time">${entry.time}</span>`;
    const ec = AUTHOR_COLORS[entry.author] || { base: '#f5f5f5', tint: 'rgba(245,245,245,0.35)', badge: '#999' };

    if (entry.type === 'checkin') {
      groupAuthor = entry.author;
      li.className = 'log-entry checkin';
      li.style.background = ec.base;
      // Check-in: badge far left, then timestamp, then content
      const badgeHtml = `<span class="author-badge" style="background:${ec.badge};color:#fff">${entry.author}</span>`;
      const locationHtml = entry.gps
        ? `${checkinMapHtml(entry.gps.lat, entry.gps.lon)}<span class="checkin-coords">${entry.gps.lat.toFixed(5)}, ${entry.gps.lon.toFixed(5)}</span>`
        : '<span class="checkin-no-gps">Location unavailable</span>';
      li.innerHTML = `${badgeHtml}${timeEl}<div class="entry-body">
        <span class="checkin-label">📍 Checked in</span>${locationHtml}
      </div>`;
    } else {
      // Notes and photos: no badge — author is communicated by group color
      li.className = 'log-entry';
      if (groupAuthor) {
        li.style.background = AUTHOR_COLORS[groupAuthor]?.tint || '';
      }

      if (entry.type === 'photo') {
        let thumb = '';
        if (s.vault && entry.photo) {
          const url = await vault.getPhotoUrl(s.vault, s.viewedDate, entry.photo);
          if (url) thumb = `<img class="entry-thumb" src="${url}" alt="">`;
        }
        li.innerHTML = `${timeEl}<div class="entry-body">
          <div class="entry-photo-wrap">${thumb || '<span class="photo-icon">📷</span>'}</div>
          <p class="entry-comment">${esc(entry.comment)}</p>
        </div>`;
      } else {
        li.innerHTML = `${timeEl}<div class="entry-body">${esc(entry.text)}</div>`;
      }
    }
    list.appendChild(li);
  }
}

// ---- Day navigation ----

async function loadAvailableDays() {
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

function updateDayNavUI() {
  const idx = s.availableDays.indexOf(s.viewedDate);
  $('day-nav-label').textContent = s.viewedDate === TODAY ? 'Today' : fmtDate(s.viewedDate);
  $('day-prev').disabled = idx <= 0;
  $('day-next').disabled = idx < 0 || idx >= s.availableDays.length - 1;
}

function updateActionBarState() {
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

// ---- Wiki tab ----
function setupWikiTab() {
  $('wiki-search').addEventListener('input', e => renderWikiList(e.target.value.toLowerCase().trim()));
  $('article-back').addEventListener('click', () => $('wiki-article').classList.remove('open'));
}

async function loadWiki() {
  if (!s.vault) return;
  try {
    s.wikiPages = await vault.loadWikiPages(s.vault);
    renderTodayStrip();
    renderWikiList('');
  } catch {}
}

const TRANSPORT_EMOJI = { flight: '✈️', train: '🚆', bus: '🚌', ferry: '⛴️', other: '🎫' };

function formatTodayLine(p) {
  if (p.type === 'hotel') {
    const bkfast = p.breakfast_included
      ? (p.breakfast_time ? `breakfast ${p.breakfast_time}` : 'breakfast included')
      : 'breakfast none';
    return `🏨 ${esc(p.name)} · check-in ${p.check_in_time || '—'} · check-out ${p.check_out_time || '—'} · ${bkfast}`;
  }
  if (p.type === 'transport') {
    const emoji = TRANSPORT_EMOJI[p.subtype] || '🎫';
    if (p.subtype === 'flight') {
      return `${emoji} ${esc(p.name)} · departs ${p.departure_time || '—'} ${esc(p.departure_point || '')} · arrives ${p.arrival_time || '—'}`;
    }
    return `${emoji} ${esc(p.name)} · ${esc(p.departure_point || '—')} ${p.departure_time || '—'} · ${esc(p.arrival_point || '—')} ${p.arrival_time || '—'}`;
  }
  if (p.type === 'activity') {
    const parts = [`🎟️ ${esc(p.name)}`];
    if (p.reservation_time) parts.push(p.reservation_time);
    if (p.meeting_point) parts.push(esc(p.meeting_point));
    return parts.join(' · ');
  }
  return esc(p.name);
}

function buildFoldHtml(p, idx) {
  const rows = [];
  if (p.type === 'hotel' && p.laundry) {
    rows.push(`<div class="today-fold-row">🧺 ${esc(p.laundry)}</div>`);
  }
  if (p.type === 'hotel' && p.room_service_url) {
    rows.push(`<div class="today-fold-row"><a href="${esc(p.room_service_url)}" target="_blank" rel="noopener">Room service menu</a></div>`);
  }
  if (p.type === 'activity' && p.details_url) {
    rows.push(`<div class="today-fold-row"><a href="${esc(p.details_url)}" target="_blank" rel="noopener">Details</a></div>`);
  }
  if (p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined) {
    const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
    rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
  }
  if (p.special_notes) {
    rows.push(`<div class="today-fold-row">📝 ${esc(p.special_notes)}</div>`);
  }
  if (p.reservation_items && p.reservation_items.length) {
    const items = p.reservation_items.map(item => `<li>${esc(item)}</li>`).join('');
    rows.push(`<div class="today-fold-row"><ol class="today-fold-list">${items}</ol></div>`);
  }
  if (p.source) {
    rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(p.source)}">
      <span class="today-source-label">Original capture →</span>
      <div class="today-source-content" style="display:none"></div>
    </div>`);
  }
  return rows.join('');
}

function renderTodayStrip() {
  const strip = $('today-strip');
  const items = s.wikiPages.filter(p => {
    if (p.type === 'hotel' && p.check_in_date && p.check_out_date) {
      return p.check_in_date <= TODAY && TODAY <= p.check_out_date;
    }
    if (p.type === 'transport' && p.date) return p.date === TODAY;
    if (p.type === 'activity' && p.reservation_date) return p.reservation_date === TODAY;
    return false;
  });

  function primaryTime(p) {
    if (p.type === 'hotel')     return p.check_in_time  || '00:00';
    if (p.type === 'transport') return p.departure_time || '00:00';
    if (p.type === 'activity')  return p.reservation_time || '00:00';
    return '00:00';
  }
  items.sort((a, b) => primaryTime(a).localeCompare(primaryTime(b)));

  if (!items.length) { strip.innerHTML = ''; return; }

  strip.innerHTML = '<div class="today-strip-heading">Today</div>' +
    items.map((p, i) => {
      const foldHtml = buildFoldHtml(p, i);
      const hasArrow = !!foldHtml;
      return `<div class="today-item">
        <div class="today-item-row" data-idx="${i}">
          <span class="today-item-line">${formatTodayLine(p)}</span>
          ${hasArrow ? '<span class="today-item-arrow">›</span>' : ''}
        </div>
        ${foldHtml ? `<div class="today-fold" data-idx="${i}">${foldHtml}</div>` : ''}
      </div>`;
    }).join('');

  strip.querySelectorAll('.today-item-row[data-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const idx = row.dataset.idx;
      const fold = strip.querySelector(`.today-fold[data-idx="${idx}"]`);
      if (!fold) return;
      const opening = !fold.classList.contains('open');
      fold.classList.toggle('open', opening);
      const arrow = row.querySelector('.today-item-arrow');
      if (arrow) arrow.textContent = opening ? '∨' : '›';
      if (opening) loadTodaySourceFile(fold);
    });
  });
}

async function loadTodaySourceFile(foldEl) {
  if (!s.vault) return;
  const sourceRow = foldEl.querySelector('.today-source-row');
  if (!sourceRow || sourceRow.dataset.loaded) return;
  const sourcePath = sourceRow.dataset.source;
  if (!sourcePath) return;

  try {
    const text = await vault.readSourceFile(s.vault, sourcePath);
    if (text !== null) {
      const contentEl = sourceRow.querySelector('.today-source-content');
      contentEl.textContent = text;
      contentEl.style.display = '';
    }
  } catch { /* omit content if unreadable */ }
  sourceRow.dataset.loaded = '1';
}

const TYPE_LABEL = { hotel: 'Hotels', restaurant: 'Restaurants', activity: 'Activities', transport: 'Transport', area: 'Areas' };

function renderWikiList(query) {
  const el = $('wiki-list');
  const pages = query
    ? s.wikiPages.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.area.toLowerCase().includes(query) ||
        p.tags.some(t => t.toLowerCase().includes(query)))
    : s.wikiPages;

  if (!pages.length) { el.innerHTML = '<p class="empty-state">No pages</p>'; return; }

  const grouped = {};
  for (const p of pages) { if (!grouped[p.type]) grouped[p.type] = []; grouped[p.type].push(p); }

  el.innerHTML = Object.entries(grouped).map(([type, items]) => `
    <div class="wiki-section">
      <h4>${TYPE_LABEL[type] || type}</h4>
      ${items.map(p => `
        <div class="wiki-item" data-slug="${p.slug}" data-type="${p.type}">
          <div>
            <div class="wiki-name">${esc(p.name)}</div>
            ${p.area ? `<div class="wiki-area">${esc(p.area)}</div>` : ''}
          </div>
          ${p.rating ? `<span class="wiki-rating">${'★'.repeat(+p.rating)}</span>` : ''}
        </div>`).join('')}
    </div>`).join('');

  el.querySelectorAll('.wiki-item').forEach(el => el.addEventListener('click', () => {
    const page = s.wikiPages.find(p => p.slug === el.dataset.slug && p.type === el.dataset.type);
    if (page) openArticle(page);
  }));
}

function openArticle(page) {
  $('article-content').textContent = `${page.name}\n\n${page.content}`;
  $('wiki-article').classList.add('open');
}

// ---- Tabs ----
function setupTabs() {
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    $$('.tab-btn').forEach(b   => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  }));
}

// ---- Sync status ----
function setSyncStatus(status) {
  s.syncStatus = status;
  const dot = $('sync-dot');
  dot.className = `sync-dot ${status}`;
  dot.title = status;
}

async function checkConflicts() {
  if (!s.vault) return;
  const found = await vault.detectConflicts(s.vault, TODAY);
  if (found.length) {
    $('conflict-msg').textContent =
      `Sync conflict in log.md — resolve in Obsidian (${found.length} file${found.length > 1 ? 's' : ''})`;
    showBanner('conflict-banner');
  }
}

function showBanner(id = 'vault-banner') { $(id).classList.add('show'); }
function hideBanner(id = 'vault-banner') { $(id).classList.remove('show'); }

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

async function sampleGpsForProximity() {
  if (!navigator.geolocation) return null;
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      ()  => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
    );
  });
}

// Returns 'ok' or 'out-of-range'. Never blocks on GPS failure.
async function checkProximity() {
  const checkinGps = getLastCheckinGps();
  if (!checkinGps) return 'ok';               // no GPS reference — can't check
  const currentGps = await sampleGpsForProximity();
  if (!currentGps) return 'ok';               // GPS unavailable — don't block
  const dist = haversineMetres(checkinGps.lat, checkinGps.lon, currentGps.lat, currentGps.lon);
  return dist <= CHECKIN_PROXIMITY_THRESHOLD_M ? 'ok' : 'out-of-range';
}

// Writes a pending draft entry to the log without calling loadLog().
// Called from checkIn() after the new check-in line is already written.
async function autoSubmitDraft(draft) {
  if (draft.type === 'note') {
    await writeLogLine(`${nowHHMM()} | ${s.author} | ${draft.text}`);
  } else if (draft.type === 'photo') {
    await finishPhotoWrite(draft.file, draft.ts, draft.comment);
  }
}

function showPendingDraft(previewText) {
  $('pending-preview').textContent = previewText;
  $('add-bar').style.display = 'none';
  $('add-bar-hint').style.display = 'none';
  $('pending-draft').style.display = 'block';
}

function hidePendingDraft() {
  s.pendingDraft = null;
  $('pending-draft').style.display = 'none';
  $('add-bar').style.display = '';       // reverts to flex via .add-bar CSS
  updateActionBarState();                // re-evaluates hint and button states
}

// ---- Helpers ----
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

function nowHHMM()   { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowHHMMSS() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function pad(n)      { return String(n).padStart(2, '0'); }
function esc(str)    { return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDate(d)  { const [y,m,day] = d.split('-').map(Number); return `${day} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]} ${y}`; }
function $(id)       { return document.getElementById(id); }
function $$(sel)     { return document.querySelectorAll(sel); }
function show(id)    { $(id).classList.remove('hidden'); }
function hide(id)    { $(id).classList.add('hidden'); }

$('reset-btn-1').addEventListener('click', resetApp);
$('reset-btn-2').addEventListener('click', resetApp);

init();
