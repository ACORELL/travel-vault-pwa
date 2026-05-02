// One-shot recovery: pull every day's shared timeline + referenced thumbs
// from the data repo back into local IDB. Used after "Clear browsing data"
// or a fresh install. The data repo is the canonical source; the local IDB
// is the working cache.
//
// Phase 5 schema: one days/<date>/timeline.json per day (both authors).
// For every date in days/ we fetch the file, hydrate timeline.js's
// day-cache, then walk every entry and appendment with a `ref` and pull
// the thumb blob into thumbs-local.

import {
  getFile, getBinary, listDir,
  GitHubAuthError, GitHubNotFoundError,
} from './github.js';
import { putCached } from './timeline.js';
import { storeLocal } from './thumbs.js';
import { daysPath, getActiveSlug } from './trip-context.js';

async function listDates() {
  try {
    // Lists the dates in the *active trip*'s days/ folder. Switching trips
    // requires a re-restore — that's intentional, see /vault/pipeline/TRIP-MANAGEMENT-PLAN.md.
    const items = await listDir(`${getActiveSlug()}/days`);
    return items
      .filter(i => i.type === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(i.name))
      .map(i => i.name)
      .sort()
      .reverse();
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    if (e instanceof GitHubNotFoundError) return [];
    throw e;
  }
}

function refsIn(entries) {
  const refs = [];
  for (const e of entries) {
    if (e.ref) refs.push(e.ref);
    for (const a of e.appendments || []) if (a.ref) refs.push(a.ref);
  }
  return refs;
}

function countItems(entries) {
  let n = entries.length;
  for (const e of entries) n += (e.appendments || []).length;
  return n;
}

export async function restoreFromRepo(onProgress = () => {}) {
  const dates = await listDates();
  let entries = 0;
  let thumbs  = 0;

  for (const date of dates) {
    onProgress({ phase: 'date', date, entries, thumbs });

    let dayEntries;
    let sha;
    try {
      const fetched = await getFile(daysPath(`${date}/timeline.json`));
      sha = fetched.sha;
      try { dayEntries = JSON.parse(fetched.content); } catch { dayEntries = []; }
      if (!Array.isArray(dayEntries)) dayEntries = [];
    } catch (e) {
      if (e instanceof GitHubAuthError) throw e;
      if (e instanceof GitHubNotFoundError) continue;
      onProgress({ phase: 'error', date, message: e.message });
      continue;
    }

    await putCached(date, dayEntries, sha);
    entries += countItems(dayEntries);
    onProgress({ phase: 'date-entries-done', date, entries, thumbs });

    for (const ref of refsIn(dayEntries)) {
      try {
        const { blob, sha } = await getBinary(daysPath(`${date}/thumbs/${ref}`), 'image/jpeg');
        await storeLocal(ref, blob, sha);
        thumbs++;
        onProgress({ phase: 'thumb', date, entries, thumbs });
      } catch (e) {
        if (e instanceof GitHubAuthError) throw e;
        if (e instanceof GitHubNotFoundError) continue;
        onProgress({ phase: 'error', date, ref, message: e.message });
      }
    }
  }

  return { entries, thumbs, dates: dates.length };
}
