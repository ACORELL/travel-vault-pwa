// File System Access API — all vault read/write operations.
// The vault folder lives on the phone's local storage.
// Obsidian Sync handles cross-device sync independently.

export async function pickVaultFolder() {
  if (!window.showDirectoryPicker) {
    throw new Error('File System Access API is not supported in this browser.');
  }
  return window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
}

export async function isVaultRoot(handle) {
  try { await handle.getFileHandle('trip.md'); return true; }
  catch { return false; }
}

// Query only — safe to call without a user gesture.
export async function queryPermission(handle) {
  if (!handle) return 'denied';
  try { return await handle.queryPermission({ mode: 'readwrite' }); }
  catch { return 'denied'; }
}

// Request — MUST be called from a user gesture (button tap).
export async function requestPermission(handle) {
  if (!handle) return false;
  try { return await handle.requestPermission({ mode: 'readwrite' }) === 'granted'; }
  catch { return false; }
}

// ---- Internal helpers ----

async function dir(root, ...parts) {
  let h = root;
  for (const p of parts) h = await h.getDirectoryHandle(p, { create: true });
  return h;
}

async function readText(dirHandle, filename) {
  try {
    const fh = await dirHandle.getFileHandle(filename);
    return await (await fh.getFile()).text();
  } catch { return null; }
}

async function writeText(dirHandle, filename, content) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w  = await fh.createWritable();
  await w.write(content);
  await w.close();
}

async function writeBlob(dirHandle, filename, blob) {
  const fh = await dirHandle.getFileHandle(filename, { create: true });
  const w  = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    await dirHandle.removeEntry(filename).catch(() => {});
    throw e;
  }
}

// ---- Log ----

export async function readLogMd(vault, date) {
  return readText(await dir(vault, 'days', date), 'log.md');
}

export async function appendLogLines(vault, date, lines) {
  const dayDir   = await dir(vault, 'days', date);
  const existing = await readText(dayDir, 'log.md') ?? '';
  const content  = existing.trim()
    ? existing.trimEnd() + '\n' + lines.join('\n') + '\n'
    : `---\ndate: ${date}\nauthors: [N, A]\n---\n\n` + lines.join('\n') + '\n';
  await writeText(dayDir, 'log.md', content);
}

// ---- Conflict detection ----
// Obsidian Sync names conflict files: filename.sync-conflict-YYYYMMDD-HHMMSS.ext

export async function detectConflicts(vault, date) {
  const found = [];
  try {
    const dayDir = await vault.getDirectoryHandle('days')
      .then(d => d.getDirectoryHandle(date));
    for await (const [name, handle] of dayDir) {
      if (handle.kind === 'file' && name.includes('.sync-conflict-')) found.push(name);
    }
  } catch {}
  return found;
}

// ---- Photos ----

export async function savePhoto(vault, date, file, name) {
  await writeBlob(await dir(vault, 'days', date, 'photos'), name, file);
}

export async function photoExists(vault, date, name) {
  try {
    await (await dir(vault, 'days', date, 'photos')).getFileHandle(name);
    return true;
  } catch { return false; }
}

export async function getPhotoUrl(vault, date, filename) {
  try {
    const fh = await (await dir(vault, 'days', date, 'photos')).getFileHandle(filename);
    return URL.createObjectURL(await fh.getFile());
  } catch { return null; }
}

// ---- Source file reader ----

// sourcePath: relative vault path, e.g. "wiki/history/2026-06-01_hotel.md"
export async function readSourceFile(vault, sourcePath) {
  try {
    const parts = sourcePath.split('/').filter(Boolean);
    let d = vault;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    const fh = await d.getFileHandle(parts[parts.length - 1]);
    return await (await fh.getFile()).text();
  } catch { return null; }
}

// ---- Raw wiki ----

export async function saveRawEntry(vault, filename, content) {
  await writeText(await dir(vault, 'wiki', 'raw'), filename, content);
}

export async function rawFileExists(vault, filename) {
  try {
    await (await dir(vault, 'wiki', 'raw')).getFileHandle(filename);
    return true;
  } catch { return false; }
}

export async function loadTodayRaw(vault, date) {
  const rawDir  = await dir(vault, 'wiki', 'raw');
  const entries = [];
  for await (const [name, handle] of rawDir) {
    if (handle.kind !== 'file' || !name.endsWith('.md') || !name.startsWith(date)) continue;
    try { entries.push({ name, content: await (await handle.getFile()).text() }); } catch {}
  }
  return entries;
}

// ---- Day folder listing ----

export async function listDayFolders(vault) {
  const folders = [];
  try {
    const daysDir = await vault.getDirectoryHandle('days');
    for await (const [name, handle] of daysDir) {
      if (handle.kind === 'directory' && /^\d{4}-\d{2}-\d{2}$/.test(name)) {
        folders.push(name);
      }
    }
  } catch {}
  return folders.sort();
}

// ---- Wiki browse ----

const FOLDERS = {
  hotels: 'hotel', restaurants: 'restaurant',
  activities: 'activity', transport: 'transport', areas: 'area',
};

export async function loadWikiPages(vault) {
  const pages = [];
  let wikiDir;
  try { wikiDir = await vault.getDirectoryHandle('wiki'); } catch { return pages; }

  for (const [folder, type] of Object.entries(FOLDERS)) {
    let typeDir;
    try { typeDir = await wikiDir.getDirectoryHandle(folder); } catch { continue; }
    for await (const [name, handle] of typeDir) {
      if (handle.kind !== 'file' || !name.endsWith('.md')) continue;
      try {
        const page = parsePage(await (await handle.getFile()).text(), type, name.slice(0, -3));
        if (page) pages.push(page);
      } catch {}
    }
  }
  return pages;
}

function parseFrontmatter(yamlText) {
  const fm = {};
  const lines = yamlText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Skip indented lines (nested keys); list items consumed below
    if (!line || /^\s/.test(line)) { i++; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    i++;
    if (rest === '' || rest === 'null' || rest === '~') {
      // Collect block list items
      const items = [];
      while (i < lines.length && /^  - /.test(lines[i])) {
        items.push(lines[i].replace(/^  - /, '').replace(/^['"]|['"]$/g, '').trim());
        i++;
      }
      fm[key] = items.length > 0 ? items : null;
    } else if (rest === '[]') {
      fm[key] = [];
    } else if (rest === 'true') {
      fm[key] = true;
    } else if (rest === 'false') {
      fm[key] = false;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline list: [tag1, tag2]
      const inner = rest.slice(1, -1).trim();
      fm[key] = inner ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    } else {
      fm[key] = rest.replace(/^['"]|['"]$/g, '');
    }
  }
  return fm;
}

function parsePage(text, type, slug) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const tags = Array.isArray(fm.tags)
    ? fm.tags
    : (typeof fm.tags === 'string' ? fm.tags.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean) : []);
  // parseFrontmatter can't handle nested YAML objects; parse coords via regex
  const latM = m[1].match(/^\s+lat:\s*(-?[\d.]+)/m);
  const lonM = m[1].match(/^\s+lon:\s*(-?[\d.]+)/m);
  const lat = latM ? parseFloat(latM[1]) : null;
  const lon = lonM ? parseFloat(lonM[1]) : null;
  return {
    type, slug,
    name:   fm.name || slug,
    area:   fm.area || '',
    rating: fm.rating_personal || null,
    tags,
    content: m[2].trim(),
    // Hotel fields
    booking_reference: fm.booking_reference || null,
    check_in_date:    fm.check_in_date  || null,
    check_out_date:   fm.check_out_date || null,
    check_in_time:    fm.check_in_time  || null,
    check_out_time:   fm.check_out_time || null,
    check_in_time_weekend:  fm.check_in_time_weekend  || null,
    check_out_time_weekend: fm.check_out_time_weekend || null,
    breakfast_included: fm.breakfast_included ?? null,
    breakfast_time:   fm.breakfast_time  || null,
    laundry:          fm.laundry         || null,
    room_service_url: fm.room_service_url || null,
    phone:            fm.phone           || null,
    website_url:      fm.website_url     || null,
    address:          fm.address         || null,
    // Transport fields
    subtype:          fm.subtype          || null,
    airline:          fm.airline          || null,
    date:             fm.date             || null,
    departure_time:   fm.departure_time   || null,
    departure_point:  fm.departure_point  || null,
    arrival_time:     fm.arrival_time     || null,
    arrival_point:    fm.arrival_point    || null,
    // Activity fields
    reservation_date: fm.reservation_date || null,
    reservation_time: fm.reservation_time || null,
    duration:         fm.duration         || null,
    meeting_point:    fm.meeting_point    || null,
    details_url:      fm.details_url      || null,
    // Shared enriched fields
    special_notes:    fm.special_notes    || null,
    reservation_items: Array.isArray(fm.reservation_items) ? fm.reservation_items : [],
    sources: Array.isArray(fm.sources) ? fm.sources : (fm.sources ? [fm.sources] : (fm.source ? [fm.source] : [])),
    lat, lon,
    maps_url: fm.maps_url || null,
  };
}
