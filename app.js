import { saveVaultHandle, getVaultHandle, enqueueLogEntry, enqueueRaw, getLogQueue, getRawQueue, clearLogKeys, clearRawKeys } from './db.js';
import { extractTimestamp } from './exif.js';
import * as vault from './vault.js';

// ---- Constants ----
const TODAY = new Date().toISOString().slice(0, 10);

// ---- State ----
const s = {
  author:     localStorage.getItem('tv-author'),
  vault:      null,
  syncStatus: 'offline',
  logEntries: [],
  wikiPages:  [],
  rawToday:   [],
  pendingPhoto: null, // { file, ts }
};

// ---- Boot ----
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    // When a new SW takes control, reload so all files come from the same cache version
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  // Step 1: author selection
  if (!s.author) {
    show('setup-overlay');
    $$('.author-btn').forEach(btn => btn.addEventListener('click', async () => {
      s.author = btn.dataset.initial;
      localStorage.setItem('tv-author', s.author);
      hide('setup-overlay');
      // Step 2: vault folder — only needed once
      let saved = null;
      try { saved = await getVaultHandle(); } catch {}
      if (saved) { show('app'); startApp(saved); }
      else        { show('vault-setup-overlay'); }
    }));
    return;
  }

  // Author known — check for stored vault handle
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

  // Query permission — safe without a user gesture.
  // If not granted, show banner; user taps Authorize to re-grant.
  const perm = await vault.queryPermission(handle);
  if (perm === 'granted') {
    s.vault = handle;
    setSyncStatus('synced');
  } else {
    showBanner();
  }

  setupTabs();
  setupLogTab();
  setupRawTab();
  setupWikiTab();

  await loadLog();
  if (s.vault) {
    await syncQueue();
    await loadRawToday();
    await loadWiki();
    await checkConflicts();
  }
}

// Re-authorization — called from a button tap (user gesture required by browser)
$('reconnect-btn').addEventListener('click', async () => {
  const handle = await getVaultHandle();
  if (!handle) return;
  const ok = await vault.requestPermission(handle);
  if (ok) {
    s.vault = handle;
    hideBanner('vault-banner');
    setSyncStatus('syncing');
    await syncQueue();
    await loadLog();
    await loadRawToday();
    await loadWiki();
    await checkConflicts();
    setSyncStatus('synced');
  }
});

$('conflict-dismiss').addEventListener('click', () => hideBanner('conflict-banner'));

// ---- Queue flush ----
async function syncQueue() {
  const { items: logItems, keys: logKeys } = await getLogQueue();
  const { items: rawItems, keys: rawKeys } = await getRawQueue();
  if (!logItems.length && !rawItems.length) return;

  setSyncStatus('syncing');
  try {
    for (const item of rawItems) await vault.saveRawEntry(s.vault, item.filename, item.content);
    if (rawKeys.length) await clearRawKeys(rawKeys);

    // Group log lines by date, flush photos alongside
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
}

function openNoteForm() {
  $('note-text').value = '';
  $('note-confirm').disabled = true;
  show('note-form');
  $('note-text').focus();
}

async function submitNote() {
  const text = $('note-text').value.trim();
  if (!text) return;
  hide('note-form');
  $('note-text').value = '';
  await writeLogLine(`${nowHHMM()} | ${s.author} | ${text}`);
  await loadLog();
}

async function onPhotoSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const ts = await extractTimestamp(file) || nowHHMMSS();
  s.pendingPhoto = { file, ts, gps: null };

  // Request location in background — ready by the time user finishes typing comment
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => { if (s.pendingPhoto) s.pendingPhoto.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude }; },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  }

  const prev = $('photo-preview');
  prev.src = URL.createObjectURL(file);
  prev.style.display = 'block';
  $('photo-pick-area').style.display = 'none';
  $('photo-comment').disabled = false;
  $('photo-comment').value = '';
  $('photo-confirm').disabled = true;
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

  const { file, ts, gps } = s.pendingPhoto;
  s.pendingPhoto = null;
  cancelPhotoForm(); // resets UI

  const hms     = ts.replace(/:/g, '-');
  const ext     = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const base    = `${hms}_${s.author}`;
  const name    = await resolvePhotoName(base, ext);
  const time    = ts.slice(0, 5);
  const gpsPart = gps ? ` | ${gps.lat.toFixed(6)},${gps.lon.toFixed(6)}` : '';
  const line    = `${time} | ${s.author} | 📷 ${name} | "${comment}"${gpsPart}`;

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
  await loadLog();
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
      const text = await vault.readLogMd(s.vault, TODAY);
      if (text) s.logEntries = parseLogMd(text);
    } catch {}
  }

  // Merge queued entries for display
  const { items } = await getLogQueue();
  for (const item of items) {
    if (item.date === TODAY) {
      const parsed = parseLogLine(item.line);
      if (parsed) s.logEntries.push(parsed);
    }
  }
  s.logEntries.sort((a, b) => a.time.localeCompare(b.time));
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
    list.innerHTML = '<li class="empty-state">No entries yet today</li>';
    return;
  }
  list.innerHTML = '';
  for (const entry of s.logEntries) {
    const li = document.createElement('li');
    li.className = 'log-entry';
    const timeEl = `<span class="entry-time">${entry.time}</span>`;
    if (entry.type === 'photo') {
      let thumb = '';
      if (s.vault && entry.photo) {
        const url = await vault.getPhotoUrl(s.vault, TODAY, entry.photo);
        if (url) thumb = `<img class="entry-thumb" src="${url}" alt="">`;
      }
      li.innerHTML = `${timeEl}<div class="entry-body">
        <div class="entry-photo-wrap">${thumb || '<span class="photo-icon">📷</span>'}</div>
        <p class="entry-comment">${esc(entry.comment)}</p>
      </div>`;
    } else {
      li.innerHTML = `${timeEl}<div class="entry-body">${esc(entry.text)}</div>`;
    }
    list.appendChild(li);
  }
}

// ---- Raw tab ----
let rawSelectedType = null;

function setupRawTab() {
  $$('.type-chip').forEach(chip => chip.addEventListener('click', () => {
    $$('.type-chip').forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    rawSelectedType = chip.dataset.type;
  }));
  $('raw-text').addEventListener('input', updateRawBtn);
  $('raw-save-btn').addEventListener('click', saveRaw);
}

function updateRawBtn() {
  $('raw-save-btn').disabled = !$('raw-text').value.trim();
}

async function saveRaw() {
  const text = $('raw-text').value.trim();
  if (!text) return;
  const ts       = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
  const suffix   = rawSelectedType ? `_${rawSelectedType}` : '';
  const filename = `${TODAY}-${ts}${suffix}.md`;
  const content  = rawSelectedType ? `type: ${rawSelectedType}\n\n${text}` : text;

  if (s.vault) {
    try { await vault.saveRawEntry(s.vault, filename, content); }
    catch { await enqueueRaw({ filename, content }); setSyncStatus('offline'); showBanner(); }
  } else {
    await enqueueRaw({ filename, content });
  }

  $('raw-text').value = '';
  $$('.type-chip').forEach(c => c.classList.remove('selected'));
  rawSelectedType = null;
  updateRawBtn();
  await loadRawToday();
}

async function loadRawToday() {
  if (!s.vault) return;
  try { s.rawToday = await vault.loadTodayRaw(s.vault, TODAY); }
  catch { s.rawToday = []; }
  renderRawToday();
}

function renderRawToday() {
  const el = $('raw-today-list');
  if (!s.rawToday.length) { el.innerHTML = '<p class="empty-state" style="padding:16px 0">Nothing captured today</p>'; return; }
  el.innerHTML = s.rawToday.map(({ content }) => {
    const typeM   = content.match(/^type:\s*(\w+)/);
    const type    = typeM ? typeM[1] : '';
    const preview = content.replace(/^type:\s*\w+\n+/, '').slice(0, 100);
    return `<div class="raw-item">
      <div>${esc(preview)}</div>
      ${type ? `<div class="raw-type">${type}</div>` : ''}
    </div>`;
  }).join('');
}

// ---- Wiki tab ----
function setupWikiTab() {
  $('wiki-search').addEventListener('input', e => renderWikiList(e.target.value.toLowerCase().trim()));
  $('article-back').addEventListener('click', () => $('wiki-article').classList.remove('open'));
}

async function loadWiki() {
  if (!s.vault) return;
  try { s.wikiPages = await vault.loadWikiPages(s.vault); renderWikiList(''); }
  catch {}
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

// ---- Helpers ----
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
