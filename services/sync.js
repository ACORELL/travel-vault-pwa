// Deferred sync: publishes today's per-author timeline + unsynced thumbs to
// the data repo. Triggers: explicit "Sync now" button, app foreground, and
// the 'online' event. The local IDB stores are the durable buffer — failed
// syncs leave local state unchanged and retry on the next trigger.
//
// Note on PHASE4.md D2: thumbs go via direct putFile rather than through
// services/queue.js. thumbs-local + thumbs-sync-state already provides the
// per-ref offline durability the queue would replicate, and using the queue
// would force a queue-extension to track which items succeeded (D2 forbids
// extending the queue). The queue contract stays preserved — it continues
// to handle raw note captures, untouched.

import { get, AUTHOR } from './settings.js';
import { putFile, GitHubAuthError, GitHubConflictError } from './github.js';
import { getOwn } from './timeline.js';
import { unsyncedRefs, getLocalBlob, markSynced } from './thumbs.js';

const STATE_KEY = 'tv-sync-state';
const AUTO_THROTTLE_MS = 60_000;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function selfAuthor() {
  const a = get(AUTHOR);
  if (a !== 'N' && a !== 'A') throw new Error(`Author not set (got ${a})`);
  return a;
}

function readState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); }
  catch { return {}; }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  localStorage.setItem(STATE_KEY, JSON.stringify(next));
}

function timelineKey(date, author) {
  return `${date}/${author}`;
}

// ─── syncToday ────────────────────────────────────────────────────────────────
// Order: thumbs first, timeline.json last. A failure between them leaves
// orphan thumb files (harmless — referenced by unique ref filenames) and the
// timeline.json continues to point at them on the retry.
export async function syncToday() {
  const date   = todayStr();
  const author = selfAuthor();
  const result = { entriesUploaded: 0, thumbsUploaded: 0, errors: [] };

  // 1. Push unsynced thumbs.
  for (const ref of await unsyncedRefs(date)) {
    const blob = await getLocalBlob(ref);
    if (!blob) continue;
    try {
      await putFile(`days/${date}/thumbs/${ref}`, blob, `Add thumbnail ${ref}`);
      await markSynced(ref);
      result.thumbsUploaded++;
    } catch (e) {
      if (e instanceof GitHubAuthError) throw e;
      // Remote already has this exact path → count as synced and continue.
      if (e instanceof GitHubConflictError) {
        await markSynced(ref);
        result.thumbsUploaded++;
        continue;
      }
      // Network or unknown error — abort early; if we PUT timeline.json now
      // it would reference thumbs that aren't there yet.
      result.errors.push(`thumb ${ref}: ${e.message}`);
      writeState({ lastSyncedAt: new Date().toISOString() });
      return result;
    }
  }

  // 2. Replace today's <author>.json with the current local entries.
  const entries = await getOwn(date);
  const path    = `days/${date}/timelines/${author}.json`;
  const stored  = readState().timelineSha || {};
  const sha     = stored[timelineKey(date, author)];
  try {
    const { sha: newSha } = await putFile(
      path,
      JSON.stringify(entries, null, 2),
      `Sync ${date} timeline (${author})`,
      sha
    );
    writeState({
      timelineSha: { ...stored, [timelineKey(date, author)]: newSha },
      lastSyncedAt: new Date().toISOString(),
    });
    result.entriesUploaded = entries.length;
  } catch (e) {
    if (e instanceof GitHubAuthError) throw e;
    result.errors.push(`timeline: ${e.message}`);
    writeState({ lastSyncedAt: new Date().toISOString() });
  }
  return result;
}

export function lastSyncedAt() {
  return readState().lastSyncedAt || null;
}

// Throttle for foreground / online auto-triggers. Returns true at most once
// per AUTO_THROTTLE_MS — caller proceeds to syncToday() only on true.
let _lastAttempt = 0;
export function isAutoSyncDue() {
  const now = Date.now();
  if (now - _lastAttempt < AUTO_THROTTLE_MS) return false;
  _lastAttempt = now;
  return true;
}
