// File System Access API — all vault read/write operations.
// The vault folder lives on the phone's local storage.
// Syncthing handles cross-device sync independently.

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
// Syncthing names conflict files: filename.sync-conflict-YYYYMMDD-HHMMSS-DEVICEID.ext

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

// ---- Raw wiki ----

export async function saveRawEntry(vault, filename, content) {
  await writeText(await dir(vault, 'wiki', 'raw'), filename, content);
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

function parsePage(text, type, slug) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return {
    type, slug,
    name:   fm.name || slug,
    area:   fm.area || '',
    rating: fm.rating_personal || null,
    tags:   (fm.tags || '').replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean),
    content: m[2].trim(),
  };
}
