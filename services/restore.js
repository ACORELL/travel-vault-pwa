// One-shot recovery: pull this device's own timelines + thumbs from the
// data repo back into local IDB. Used after a "Clear browsing data" or a
// fresh PWA install — the data repo is the canonical source, the local IDB
// is the durable working buffer.
//
// Iterates every date in days/, fetches days/<date>/timelines/<self>.json,
// replays each entry into timeline-local, then pulls every referenced thumb
// into thumbs-local and marks it synced. Updates the local sha map so the
// next sync uses the correct sha for follow-up PUTs.

import { get, AUTHOR } from './settings.js';
import { getFile, getBinary, GitHubAuthError, GitHubNotFoundError } from './github.js';
import { appendLocal, listAvailableDates } from './timeline.js';
import { storeLocal, markSynced } from './thumbs.js';

const STATE_KEY = 'tv-sync-state';

function readState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); }
  catch { return {}; }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  localStorage.setItem(STATE_KEY, JSON.stringify(next));
}

export async function restoreFromRepo(onProgress = () => {}) {
  const author = get(AUTHOR);
  if (author !== 'N' && author !== 'A') throw new Error(`Author not set (got ${author})`);

  const dates = await listAvailableDates();
  let entries = 0, thumbs = 0;
  const shaMap = { ...(readState().timelineSha || {}) };

  for (const date of dates) {
    onProgress({ phase: 'date', date, entries, thumbs });
    const path = `days/${date}/timelines/${author}.json`;
    let data, sha;
    try {
      const res = await getFile(path);
      data = JSON.parse(res.content);
      sha = res.sha;
    } catch (e) {
      if (e instanceof GitHubAuthError) throw e;
      if (e instanceof GitHubNotFoundError) continue;
      onProgress({ phase: 'error', date, message: e.message });
      continue;
    }
    shaMap[`${date}/${author}`] = sha;

    for (const entry of data) {
      await appendLocal(date, entry);
      entries++;
    }
    onProgress({ phase: 'date-entries-done', date, entries, thumbs });

    for (const entry of data) {
      if (entry.type !== 'photo' || !entry.ref) continue;
      try {
        const { blob } = await getBinary(`days/${date}/thumbs/${entry.ref}`, 'image/jpeg');
        await storeLocal(entry.ref, blob);
        await markSynced(entry.ref);
        thumbs++;
        onProgress({ phase: 'thumb', date, entries, thumbs });
      } catch (e) {
        if (e instanceof GitHubAuthError) throw e;
        if (e instanceof GitHubNotFoundError) continue;
        onProgress({ phase: 'error', date, ref: entry.ref, message: e.message });
      }
    }
  }

  writeState({ timelineSha: shaMap, lastSyncedAt: new Date().toISOString() });
  return { entries, thumbs, dates: dates.length };
}
