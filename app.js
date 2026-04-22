import { saveVaultHandle, getVaultHandle, enqueueLogEntry, getLogQueue, clearLogKeys } from './db.js';
import * as vault from './vault.js';

// ---- Constants ----
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = (() => {
  const d = new Date(TODAY + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
})();
const IS_WEEKEND_TODAY = (() => {
  const day = new Date(TODAY + 'T12:00:00').getDay();
  return day === 0 || day === 6;
})();

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
    navigator.serviceWorker.register('./sw.js?v=26').catch(() => {});
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
  $('wiki-capture-btn').addEventListener('click', openCaptureSheet);
  $('capture-cancel').addEventListener('click', closeCaptureSheet);
  $('capture-save').addEventListener('click', saveRawCapture);

  if (location.search.includes('dev=1')) {
    const testBtn = document.createElement('button');
    testBtn.className = 'wiki-cap-btn';
    testBtn.textContent = 'Test strip';
    testBtn.style.marginRight = '6px';
    testBtn.addEventListener('click', renderTestStrip);
    $('wiki-cap-row').prepend(testBtn);
  }
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

// ---- Stay helpers ----
function stayDayOf(checkInDate, today) {
  const ms = new Date(today + 'T12:00:00') - new Date(checkInDate + 'T12:00:00');
  return Math.floor(ms / 86400000) + 1;
}
function stayNights(checkInDate, checkOutDate) {
  const ms = new Date(checkOutDate + 'T12:00:00') - new Date(checkInDate + 'T12:00:00');
  return Math.floor(ms / 86400000);
}

// ---- Flight detail helpers ----
function extractFlightNum(name) {
  const m = name.match(/\bFlight\s+([A-Z]{2,3}\s*\d+)/i) || name.match(/\b([A-Z]{2,3}\s*\d{2,4})\b/);
  return m ? m[1].trim() : name;
}
function extractIATA(point) {
  const m = (point || '').match(/\(([A-Z]{3})\)/);
  return m ? m[1] : null;
}
function extractTerminal(point) {
  const m = (point || '').match(/Terminal\s+(\S+)/i);
  return m ? m[1] : null;
}
function extractAirportName(point) {
  return (point || '').replace(/\s*\([A-Z]{3}\)/, '').split(',')[0].trim();
}
function extractPassengers(items) {
  return (items || []).map(item => {
    const m = item.match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : null;
  }).filter(Boolean);
}

function formatTodayLine(p) {
  if (p.type === 'hotel') {
    const x = stayDayOf(p.check_in_date, TODAY);
    const y = stayNights(p.check_in_date, p.check_out_date);
    const ciTime = (IS_WEEKEND_TODAY && p.check_in_time_weekend) ? p.check_in_time_weekend : (p.check_in_time || '—');
    return `🏨 ${esc(p.name)} · Day ${x} of ${y} · Check-in ${esc(ciTime)}`;
  }
  if (p.type === 'transport' && p.subtype === 'flight') {
    const flightNum = extractFlightNum(p.name);
    const origin = extractIATA(p.departure_point) || esc(p.departure_point || '—');
    const dest   = extractIATA(p.arrival_point)   || esc(p.arrival_point   || '—');
    return `✈️ ${esc(flightNum)} · ${esc(p.departure_time || '—')} · ${origin} → ${dest}`;
  }
  if (p.type === 'transport') {
    const emoji = TRANSPORT_EMOJI[p.subtype] || '🎫';
    return `${emoji} ${esc(p.name)} · ${esc(p.departure_point || '—')} ${esc(p.departure_time || '—')} · ${esc(p.arrival_point || '—')} ${esc(p.arrival_time || '—')}`;
  }
  if (p.type === 'activity') {
    const parts = [`🎟️ ${esc(p.name)}`];
    if (p.reservation_time) parts.push(esc(p.reservation_time));
    return parts.join(' · ');
  }
  return esc(p.name);
}

function formatTomorrowLine(p) {
  if (p.type === 'transport' && p.subtype === 'flight') {
    return `✈️ ${esc(extractFlightNum(p.name))} · ${esc(p.departure_time || '—')}`;
  }
  if (p.type === 'transport') {
    const emoji = TRANSPORT_EMOJI[p.subtype] || '🎫';
    return `${emoji} ${esc(p.name)} · ${esc(p.departure_time || '—')}`;
  }
  if (p.type === 'hotel') {
    if (p.check_in_date === TOMORROW && p.check_in_time)
      return `🏨 ${esc(p.name)} · ${esc(p.check_in_time)}`;
    if (p.check_out_date === TOMORROW && p.check_out_time)
      return `🏨 ${esc(p.name)} · ${esc(p.check_out_time)}`;
    return `🏨 ${esc(p.name)}`;
  }
  if (p.type === 'activity') {
    return `🎟️ ${esc(p.name)} · ${esc(p.reservation_time || '—')}`;
  }
  return esc(p.name);
}

// ---- Fold-out helpers ----
function pairRow(col1Html, col2Html) {
  return `<div class="today-fold-row"><div class="strip-row">` +
    `<div class="strip-col">${col1Html}</div>` +
    `<div class="strip-col">${col2Html}</div>` +
    `</div></div>`;
}
function lv(label, value) {
  return `<span class="strip-label">${esc(label)}</span><span class="strip-value">${value}</span>`;
}

function buildFoldHtml(p, idx) {
  const rows = [];

  if (p.type === 'transport' && p.subtype === 'flight') {
    const terminal    = extractTerminal(p.departure_point);
    const terminalStr = terminal ? `Terminal ${esc(terminal)}` : 'Terminal: Not known';
    const airlineStr  = esc(p.airline || '—');
    const hasSrc      = p.sources && p.sources.length;

    // Row 1: Departs + Ref
    if (p.booking_reference) {
      rows.push(pairRow(lv('Departs', esc(p.departure_time || '—')), lv('Ref', esc(p.booking_reference))));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Departs', esc(p.departure_time || '—'))}</div>`);
    }

    // Row 2: Airline + Terminal
    rows.push(pairRow(lv('Airline', airlineStr), `<span class="strip-value">${terminalStr}</span>`));

    // Row 3: Airport name omitted — maps link below already shows it (Fix 3)

    // Row 3: Departure airport geo link
    if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">${esc(p.departure_point || 'Departure airport')}</a></div>`);
    }

    // Row 4: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    }

  } else if (p.type === 'hotel') {
    const ciTime = (IS_WEEKEND_TODAY && p.check_in_time_weekend)  ? p.check_in_time_weekend  : (p.check_in_time  || '—');
    const coTime = (IS_WEEKEND_TODAY && p.check_out_time_weekend) ? p.check_out_time_weekend : (p.check_out_time || '—');
    const hasSrc = p.sources && p.sources.length;
    const hasWeb = p.website_url;

    // Row 1: Check-in + Ref
    if (p.booking_reference) {
      rows.push(pairRow(lv('Check-in', esc(ciTime)), lv('Ref', esc(p.booking_reference))));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Check-in', esc(ciTime))}</div>`);
    }

    // Row 2: Check-out + Day X of Y
    if (p.check_in_date && p.check_out_date) {
      const x = stayDayOf(p.check_in_date, TODAY);
      const y = stayNights(p.check_in_date, p.check_out_date);
      rows.push(pairRow(lv('Check-out', esc(coTime)), `<span class="strip-value">Day ${x} of ${y}</span>`));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Check-out', esc(coTime))}</div>`);
    }

    // Row 3: Address geo link
    if (p.address) {
      const geoUri = (p.lat != null && p.lon != null)
        ? `geo:${p.lat},${p.lon}?q=${encodeURIComponent(p.address)}`
        : null;
      rows.push(geoUri
        ? `<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">${esc(p.address)}</a></div>`
        : `<div class="today-fold-row">${esc(p.address)}</div>`);
    } else if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }

    // Row 4: Phone
    if (p.phone) {
      const telHref = `tel:${p.phone.replace(/[\s-]/g, '')}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(telHref)}">${esc(p.phone)}</a></div>`);
    }

    // Row 5: Hotel website
    if (hasWeb) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.website_url)}" target="_blank" rel="noopener">Hotel website →</a></div>`);
    }

    // Row 6: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    }

  } else if (p.type === 'activity') {
    const hasSrc = p.sources && p.sources.length;
    const hasDet = p.details_url;

    // Row 1: Start time + Ref
    if (p.reservation_time && p.booking_reference) {
      rows.push(pairRow(lv('Start', esc(p.reservation_time)), lv('Ref', esc(p.booking_reference))));
    } else if (p.reservation_time) {
      rows.push(`<div class="today-fold-row">${lv('Start', esc(p.reservation_time))}</div>`);
    } else if (p.booking_reference) {
      rows.push(`<div class="today-fold-row">${lv('Ref', esc(p.booking_reference))}</div>`);
    }

    // Row 2: Address maps link
    if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }

    // Row 3: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    } else if (hasDet) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.details_url)}" target="_blank" rel="noopener">Details →</a></div>`);
    }

  } else {
    // Non-flight transport and other types
    if (p.booking_reference) {
      rows.push(`<div class="today-fold-row"><span class="fold-label">Booking ref</span> ${esc(p.booking_reference)}</div>`);
    }
    if (p.maps_url) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Open in Maps →</a></div>`);
    } else if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }
    if (p.special_notes) {
      rows.push(`<div class="today-fold-row"><span class="fold-label">📝 Notes</span> ${esc(p.special_notes)}</div>`);
    }
    if (p.reservation_items && p.reservation_items.length) {
      const items = p.reservation_items.map(item => `<li>${esc(item)}</li>`).join('');
      rows.push(`<div class="today-fold-row"><span class="fold-label">Confirmed</span><ol class="today-fold-list">${items}</ol></div>`);
    }
    if (p.sources && p.sources.length) {
      p.sources.forEach(src => {
        const filename = src.split('/').pop();
        rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
          `<span class="today-source-label">${esc(filename)}</span>` +
          `<div class="today-source-content" style="display:none"></div>` +
          `</div>`);
      });
    }
  }

  return rows.join('');
}

const STRIP_CATEGORY_ORDER = ['transport', 'hotel', 'activity'];
const STRIP_CATEGORY_LABEL = { transport: 'Flights', hotel: 'Hotels', activity: 'Activities' };
const STRIP_CATEGORY_CLASS = { hotel: 'today-item-hotel', transport: 'today-item-transport', activity: 'today-item-activity' };

function primaryTime(p) {
  if (p.type === 'hotel')     return p.check_in_time    || '00:00';
  if (p.type === 'transport') return p.departure_time   || '00:00';
  if (p.type === 'activity')  return p.reservation_time || '00:00';
  return '00:00';
}

function tomorrowPrimaryTime(p) {
  if (p.type === 'hotel') {
    if (p.check_in_date === TOMORROW)  return p.check_in_time  || '00:00';
    if (p.check_out_date === TOMORROW) return p.check_out_time || '00:00';
    return '00:00';
  }
  return primaryTime(p);
}

function isPast(p) {
  const t = primaryTime(p);
  if (!t || t === '00:00') return false;
  const now = new Date();
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m <= now.getHours() * 60 + now.getMinutes();
}

function formatCountdown(timeStr) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [h, m] = (timeStr || '').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const diff = h * 60 + m - nowMins;
  if (diff <= 0) return null;
  const hrs = Math.floor(diff / 60);
  const mins = diff % 60;
  return hrs > 0 ? `In ${hrs}h ${mins}m` : `In ${mins}m`;
}

function findNextUpcoming(items) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let best = null, bestDiff = Infinity;
  for (const p of items) {
    const t = primaryTime(p);
    if (!t || t === '00:00') continue;
    const [h, m] = t.split(':').map(Number);
    const diff = h * 60 + m - nowMins;
    if (diff > 0 && diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return best;
}

function renderTodayStrip() {
  const strip = $('today-strip');

  function matchesDate(p, date) {
    if (p.type === 'hotel' && p.check_in_date && p.check_out_date) {
      return p.check_in_date <= date && date <= p.check_out_date;
    }
    if (p.type === 'transport' && p.date) return p.date === date;
    if (p.type === 'activity' && p.reservation_date) return p.reservation_date === date;
    return false;
  }

  const todayItems    = s.wikiPages.filter(p => matchesDate(p, TODAY));
  const tomorrowItems = s.wikiPages.filter(p => matchesDate(p, TOMORROW));

  if (!todayItems.length && !tomorrowItems.length) { strip.innerHTML = ''; return; }

  todayItems.sort((a, b) => primaryTime(a).localeCompare(primaryTime(b)));
  tomorrowItems.sort((a, b) => tomorrowPrimaryTime(a).localeCompare(tomorrowPrimaryTime(b)));

  const upcomingItem = findNextUpcoming(todayItems);

  const grouped = {};
  for (const p of todayItems) { (grouped[p.type] = grouped[p.type] || []).push(p); }

  let n = 0;
  let html = '<div class="today-strip-heading">Today</div>';

  for (const type of STRIP_CATEGORY_ORDER) {
    if (!grouped[type]) continue;
    html += `<div class="today-category-header">${STRIP_CATEGORY_LABEL[type]}</div>`;
    const active = grouped[type].filter(p => !isPast(p));
    const past   = grouped[type].filter(p =>  isPast(p));
    for (const p of [...active, ...past]) {
      const foldHtml = buildFoldHtml(p, n);
      const catClass     = STRIP_CATEGORY_CLASS[type] || '';
      const upcomingClass = p === upcomingItem ? ' today-item-upcoming' : '';
      const pastClass     = isPast(p) ? ' today-item-past' : '';
      const countdownStr  = p === upcomingItem ? formatCountdown(primaryTime(p)) : null;
      const countdownHtml = countdownStr ? `<span class="today-item-countdown">${countdownStr}</span>` : '';
      html += `<div class="today-item ${catClass}${upcomingClass}${pastClass}">
        <div class="today-item-row" data-idx="${n}">
          <span class="today-item-line">${formatTodayLine(p)}</span>
          ${countdownHtml}
          ${foldHtml ? '<span class="today-item-arrow">›</span>' : ''}
        </div>
        ${foldHtml ? `<div class="today-fold" data-idx="${n}">${foldHtml}</div>` : ''}
      </div>`;
      n++;
    }
  }

  if (tomorrowItems.length) {
    html += '<hr class="today-divider">';
    html += '<div class="today-strip-heading">Tomorrow</div>';
    for (const p of tomorrowItems) {
      html += `<div class="today-tomorrow-item"><span class="today-item-line">${formatTomorrowLine(p)}</span></div>`;
    }
  }

  strip.innerHTML = html;

  strip.querySelectorAll('.today-item-row[data-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const i = row.dataset.idx;
      const fold = strip.querySelector(`.today-fold[data-idx="${i}"]`);
      if (!fold) return;
      const opening = !fold.classList.contains('open');
      fold.classList.toggle('open', opening);
      const arrow = row.querySelector('.today-item-arrow');
      if (arrow) arrow.textContent = opening ? '∨' : '›';
      const item = row.closest('.today-item');
      if (item) item.classList.toggle('today-item-expanded', opening);
      if (opening) loadTodaySourceFile(fold);
    });
  });
}

async function loadTodaySourceFile(foldEl) {
  if (!s.vault) return;
  const sourceRows = foldEl.querySelectorAll('.today-source-row');
  for (const sourceRow of sourceRows) {
    if (sourceRow.dataset.loaded) continue;
    const sourcePath = sourceRow.dataset.source;
    if (!sourcePath) continue;
    const label = sourceRow.querySelector('.today-source-label');
    const contentEl = sourceRow.querySelector('.today-source-content');
    try {
      const text = await vault.readSourceFile(s.vault, sourcePath);
      if (text !== null) {
        contentEl.textContent = text;
        contentEl.style.display = '';
      } else {
        label.textContent = 'Original capture (unavailable)';
      }
    } catch {
      label.textContent = 'Original capture (unavailable)';
    }
    sourceRow.dataset.loaded = '1';
  }
}

const TYPE_LABEL = { hotel: 'Hotels', restaurant: 'Restaurants', activity: 'Activities', transport: 'Transport', area: 'Areas' };
const TYPE_ORDER = ['hotel', 'restaurant', 'activity', 'transport', 'area'];

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

  el.innerHTML = TYPE_ORDER
    .filter(type => grouped[type])
    .map(type => {
      const items = grouped[type];
      return `<div class="wiki-accordion-section">` +
        `<button class="wiki-accordion-header" data-type="${type}">` +
          `<span>${esc(TYPE_LABEL[type] || type)}</span>` +
          `<span class="wiki-accordion-arrow">›</span>` +
        `</button>` +
        `<div class="wiki-accordion-body">` +
          items.map(p =>
            `<div class="wiki-item" data-slug="${esc(p.slug)}" data-type="${esc(p.type)}">` +
              `<div>` +
                `<div class="wiki-name">${esc(p.name)}</div>` +
                (p.area ? `<div class="wiki-area">${esc(p.area)}</div>` : '') +
              `</div>` +
              (p.rating ? `<span class="wiki-rating">${'★'.repeat(+p.rating)}</span>` : '') +
            `</div>`
          ).join('') +
        `</div>` +
      `</div>`;
    }).join('');

  // When searching, expand all matching sections so results are immediately visible
  if (query) {
    el.querySelectorAll('.wiki-accordion-header').forEach(h => h.classList.add('open'));
    el.querySelectorAll('.wiki-accordion-body').forEach(b => b.classList.add('open'));
  }

  // Accordion toggle — one section open at a time
  el.querySelectorAll('.wiki-accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      const opening = !body.classList.contains('open');
      el.querySelectorAll('.wiki-accordion-header').forEach(h => h.classList.remove('open'));
      el.querySelectorAll('.wiki-accordion-body').forEach(b => b.classList.remove('open'));
      if (opening) {
        header.classList.add('open');
        body.classList.add('open');
      }
    });
  });

  el.querySelectorAll('.wiki-item').forEach(item => item.addEventListener('click', () => {
    const page = s.wikiPages.find(p => p.slug === item.dataset.slug && p.type === item.dataset.type);
    if (page) openArticle(page);
  }));
}

function openArticle(page) {
  const hotelCardEl = $('article-hotel-card');
  const mapsLinkEl  = $('article-maps-link');
  const contentEl   = $('article-content');

  if (page.type === 'hotel') {
    hotelCardEl.innerHTML = buildHotelCard(page);
    hotelCardEl.style.display = '';
    mapsLinkEl.hidden = true;
    contentEl.textContent = '';
  } else {
    hotelCardEl.innerHTML = '';
    hotelCardEl.style.display = 'none';
    contentEl.textContent = `${page.name}\n\n${page.content}`;
    if (page.maps_url && ['restaurant', 'activity', 'area'].includes(page.type)) {
      mapsLinkEl.innerHTML = `<a href="${esc(page.maps_url)}" target="_blank" rel="noopener">Open in Maps →</a>`;
      mapsLinkEl.hidden = false;
    } else {
      mapsLinkEl.innerHTML = '';
      mapsLinkEl.hidden = true;
    }
  }
  $('wiki-article').classList.add('open');
}

function buildHotelCard(page) {
  const parts = [];

  parts.push(`<h2 class="hotel-card-name">${esc(page.name)}</h2>`);

  if (page.booking_reference) {
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Booking ref</div>` +
        `<div class="hotel-card-booking-ref">${esc(page.booking_reference)}</div>` +
      `</div>`
    );
  }

  const stayRows = [];
  if (page.check_in_date || page.check_in_time) {
    const val = [page.check_in_date ? fmtDate(page.check_in_date) : null, page.check_in_time].filter(Boolean).join(' · ');
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Check-in</span><span>${esc(val)}</span></div>`);
  }
  if (page.check_out_date || page.check_out_time) {
    const val = [page.check_out_date ? fmtDate(page.check_out_date) : null, page.check_out_time].filter(Boolean).join(' · ');
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Check-out</span><span>${esc(val)}</span></div>`);
  }
  if (page.breakfast_included !== null) {
    const val = page.breakfast_included
      ? `Included${page.breakfast_time ? ` · ${page.breakfast_time}` : ''}`
      : 'Not included';
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Breakfast</span><span>${esc(val)}</span></div>`);
  }
  if (stayRows.length) {
    parts.push(`<div class="hotel-card-section">${stayRows.join('')}</div>`);
  }

  if (page.reservation_items && page.reservation_items.length) {
    const items = page.reservation_items.map(item => `<li>${esc(item)}</li>`).join('');
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Confirmed</div>` +
        `<ul class="hotel-card-list">${items}</ul>` +
      `</div>`
    );
  }

  if (page.special_notes) {
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Notes</div>` +
        `<div class="hotel-card-notes">${esc(page.special_notes)}</div>` +
      `</div>`
    );
  }

  const links = [];
  if (page.maps_url) {
    links.push(`<a href="${esc(page.maps_url)}" target="_blank" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  } else if (page.lat != null && page.lon != null) {
    const geoUri = `geo:${page.lat},${page.lon}?q=${page.lat},${page.lon}`;
    links.push(`<a href="${esc(geoUri)}" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  }
  if (page.room_service_url) {
    links.push(`<a href="${esc(page.room_service_url)}" target="_blank" rel="noopener" class="hotel-card-link">Hotel website →</a>`);
  }
  if (links.length) {
    parts.push(`<div class="hotel-card-links">${links.join('')}</div>`);
  }

  if (page.content) {
    parts.push(`<hr class="hotel-card-divider"><div class="hotel-card-body">${esc(page.content)}</div>`);
  }

  return parts.join('');
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

// ---- Raw capture ----

function openCaptureSheet() {
  $('capture-text').value = '';
  $('capture-status').style.display = 'none';
  $('capture-save').disabled = false;
  $('capture-save').textContent = 'Save';
  show('raw-capture-form');
  $('capture-text').focus();
}

function closeCaptureSheet() {
  hide('raw-capture-form');
  $('capture-text').value = '';
  $('capture-status').style.display = 'none';
}

async function saveRawCapture() {
  const text = $('capture-text').value;
  if (!text.trim()) return;

  if (!s.vault) {
    const st = $('capture-status');
    st.textContent = 'Vault not authorized — tap Authorize first';
    st.style.color = '#dc2626';
    st.style.display = 'block';
    return;
  }

  const btn = $('capture-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  let gps = null;
  if (navigator.geolocation) {
    gps = await new Promise(resolve => {
      navigator.geolocation.getCurrentPosition(
        pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        ()  => resolve(null),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
      );
    });
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const hh = pad(now.getHours()), mm = pad(now.getMinutes()), ss = pad(now.getSeconds());
  const datetime = `${datePart} ${hh}:${mm}`;
  const fileBase = `${datePart}_${hh}-${mm}-${ss}_raw`;

  const geoLine = gps ? `\ngeo: ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  const content = `# Raw capture — ${datetime}\n\n${text.trim()}\n\n---\ncaptured: ${datetime}${geoLine}\n`;

  let filename = `${fileBase}.md`;
  let n = 2;
  while (await vault.rawFileExists(s.vault, filename)) {
    filename = `${fileBase}_${n++}.md`;
  }

  try {
    await vault.saveRawEntry(s.vault, filename, content);
    const st = $('capture-status');
    st.textContent = 'Saved to raw ✓';
    st.style.color = '#166534';
    st.style.display = 'block';
    setTimeout(closeCaptureSheet, 2000);
  } catch (e) {
    console.error('Raw capture failed:', e);
    btn.disabled = false;
    btn.textContent = 'Save';
    const st = $('capture-status');
    st.textContent = 'Save failed — try again';
    st.style.color = '#dc2626';
    st.style.display = 'block';
  }
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

// ---- Test fixture ----
function renderTestStrip() {
  const testPages = [
    {
      type: 'transport', subtype: 'flight', name: 'Flight SK 683 — Copenhagen to Rome',
      departure_time: '06:45', departure_point: 'Copenhagen Airport (CPH), Terminal 2',
      arrival_time: '10:05', arrival_point: 'Rome Fiumicino Airport (FCO), Terminal 3',
      airline: 'SAS', booking_reference: 'SKAS7X',
      special_notes: 'Meal: Standard included.',
      reservation_items: ['Seat 14A (Passenger A)', 'Seat 14B (Passenger B)'],
      lat: 55.618, lon: 12.656, sources: [],
    },
    {
      type: 'hotel', name: 'Hotel Tornabuoni Roma',
      check_in_date: TODAY, check_out_date: (() => { const d = new Date(TODAY + 'T12:00:00'); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10); })(),
      check_in_time: '13:00', check_out_time: '12:00',
      check_in_time_weekend: '14:00', check_out_time_weekend: '12:00',
      booking_reference: 'HTC-88421-R',
      phone: '+39 06 6784 2200', website_url: 'https://www.tornabuoniroma.it',
      address: 'Via del Corso 12, 00186 Roma RM, Italy',
      laundry: 'Basement B1. Coin op, €4/wash.',
      room_service_url: '', maps_url: '',
      special_notes: 'No front desk after 23:00.',
      reservation_items: ['Early check-in 13:00 confirmed'],
      lat: 41.9009, lon: 12.4833, sources: [],
    },
    {
      type: 'activity', name: 'Colosseum Guided Tour',
      reservation_time: '09:00', booking_reference: 'GYG-554821',
      meeting_point: 'Outside main entrance, Piazza del Colosseo 1, Roma',
      details_url: 'https://example.com', maps_url: '',
      special_notes: 'Small group, max 12.',
      reservation_items: ['Audio headset included', '2 participants'],
      lat: 41.8902, lon: 12.4922, sources: [],
    },
  ];

  const grouped = {};
  for (const p of testPages) { (grouped[p.type] = grouped[p.type] || []).push(p); }

  let n = 0;
  let html = '<div class="today-strip-heading">Today (test)</div>';

  for (const type of STRIP_CATEGORY_ORDER) {
    if (!grouped[type]) continue;
    html += `<div class="today-category-header">${STRIP_CATEGORY_LABEL[type]}</div>`;
    for (const p of grouped[type]) {
      const foldHtml = buildFoldHtml(p, n);
      const catClass = STRIP_CATEGORY_CLASS[type] || '';
      html += `<div class="today-item ${catClass}">
        <div class="today-item-row" data-idx="${n}">
          <span class="today-item-line">${formatTodayLine(p)}</span>
          <span class="today-item-arrow">›</span>
        </div>
        <div class="today-fold" data-idx="${n}">${foldHtml}</div>
      </div>`;
      n++;
    }
  }

  const strip = $('today-strip');
  strip.innerHTML = html;

  strip.querySelectorAll('.today-item-row[data-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const i = row.dataset.idx;
      const fold = strip.querySelector(`.today-fold[data-idx="${i}"]`);
      if (!fold) return;
      const opening = !fold.classList.contains('open');
      fold.classList.toggle('open', opening);
      const arrow = row.querySelector('.today-item-arrow');
      if (arrow) arrow.textContent = opening ? '∨' : '›';
    });
  });

  // Switch to wiki tab so the strip is visible
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'wiki'));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-wiki'));
  console.log('[TV] Test strip rendered — 3 cards (hotel, transport, activity)');
}
window.renderTestStrip = renderTestStrip;

setInterval(renderTodayStrip, 60000);

init();
