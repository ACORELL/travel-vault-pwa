// Offline mutation queue (Phase 5).
//
// When a write to the data repo fails because the device is offline (or the
// network blips), the UI's optimistic local update is treated as authoritative
// and the intended remote operation is enqueued here. Drain triggers: app
// boot, 'online' event, settings save, settings test pass, and opportunistic
// drains after every successful direct write.
//
// Replays dispatch through the same primitives the UI uses (timeline.js
// mutators, github.putFile / deleteFile) so there's no duplicated mutation
// logic — each replay re-fetches sha inside atomicEdit, so order matters but
// stale snapshots don't.

import {
  addEntry, editEntry, deleteEntry,
  addAppendment, editAppendment, deleteAppendment,
  deleteMany,
} from './timeline.js';
import {
  putFile, deleteFile, getFile,
  GitHubAuthError, GitHubConflictError, GitHubNotFoundError,
} from './github.js';
import { getLocalBlob, setLocalSha } from './thumbs.js';

const DB_NAME = 'tv-ops';
const STORE   = 'queue';

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ({ target: { result: db } }) => {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { autoIncrement: true });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function tx(mode) {
  return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
}

function emitChanged() {
  window.dispatchEvent(new CustomEvent('ops-changed'));
}

// ─── Public API ───────────────────────────────────────────────────────────────

// op shape: { kind, date, args }
//   kind: 'add-entry' | 'edit-entry' | 'delete-entry'
//       | 'add-appendment' | 'edit-appendment' | 'delete-appendment'
//       | 'delete-many'
//       | 'put-thumb' | 'delete-thumb'
export async function enqueue(op) {
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.add(op);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  emitChanged();
}

export async function count() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// Set of all ids (parent entry ids and appendment ids) referenced by the
// currently-queued ops. Used by the log UI to show a "pending sync" badge
// on entries waiting for replay.
export async function pendingIds() {
  const ids = new Set();
  let items = [];
  try { ({ items } = await readAll()); } catch { return ids; }
  for (const op of items) {
    const { kind, args } = op;
    switch (kind) {
      case 'add-entry':
      case 'edit-entry':
        if (args?.entry?.id) ids.add(args.entry.id);
        if (args?.id)        ids.add(args.id);
        break;
      case 'delete-entry':
        if (args?.id) ids.add(args.id);
        break;
      case 'add-appendment':
        if (args?.parentId)        ids.add(args.parentId);
        if (args?.appendment?.id)  ids.add(args.appendment.id);
        break;
      case 'edit-appendment':
      case 'delete-appendment':
        if (args?.parentId) ids.add(args.parentId);
        if (args?.appId)    ids.add(args.appId);
        break;
      case 'delete-many':
        for (const id of args?.ids || []) ids.add(id);
        break;
    }
  }
  return ids;
}

// Set of thumb refs referenced by put-thumb / delete-thumb ops. Photo
// entries whose own id isn't pending may still have an in-flight thumb
// upload (or pending remote delete).
export async function pendingThumbRefs() {
  const refs = new Set();
  let items = [];
  try { ({ items } = await readAll()); } catch { return refs; }
  for (const op of items) {
    if (op.kind === 'put-thumb' || op.kind === 'delete-thumb') {
      if (op.args?.ref) refs.add(op.args.ref);
    }
  }
  return refs;
}

export async function clear() {
  const store = await tx('readwrite');
  await new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  emitChanged();
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function readAll() {
  const store = await tx('readonly');
  return new Promise((resolve, reject) => {
    const items = [], keys = [];
    store.openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) { items.push(cur.value); keys.push(cur.key); cur.continue(); }
      else resolve({ items, keys });
    };
    store.transaction.onerror = () => reject(store.transaction.error);
  });
}

async function deleteKey(key) {
  const store = await tx('readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function dispatch(op) {
  const { kind, date, args } = op;
  switch (kind) {
    case 'add-entry':         return addEntry(date, args.entry);
    case 'edit-entry':        return editEntry(date, args.id, args.patch);
    case 'delete-entry':      return deleteEntry(date, args.id);
    case 'add-appendment':    return addAppendment(date, args.parentId, args.appendment);
    case 'edit-appendment':   return editAppendment(date, args.parentId, args.appId, args.patch);
    case 'delete-appendment': return deleteAppendment(date, args.parentId, args.appId);
    case 'delete-many':       return deleteMany(date, args.ids);
    case 'put-thumb': {
      const blob = await getLocalBlob(args.ref);
      // Local thumb evicted before flush — the remote will rebuild from
      // tomorrow's restore-from-repo; treat as nothing-to-do.
      if (!blob) return;
      const { sha } = await putFile(`days/${date}/thumbs/${args.ref}`, blob, `Add thumbnail ${args.ref}`);
      if (sha) await setLocalSha(args.ref, sha);
      return;
    }
    case 'delete-thumb': {
      let sha;
      try { ({ sha } = await getFile(`days/${date}/thumbs/${args.ref}`)); }
      catch (e) { if (e instanceof GitHubNotFoundError) return; throw e; }
      return deleteFile(`days/${date}/thumbs/${args.ref}`, sha, `Delete thumbnail ${args.ref}`);
    }
    default:
      throw new Error(`Unknown op kind: ${kind}`);
  }
}

export async function flush() {
  const { items, keys } = await readAll();
  let flushed = 0;
  let failed  = 0;
  for (let i = 0; i < items.length; i++) {
    const op  = items[i];
    const key = keys[i];
    try {
      await dispatch(op);
      await deleteKey(key);
      flushed++;
      emitChanged();
    } catch (e) {
      if (e instanceof GitHubAuthError) {
        // Stop the drain so the UI can redirect to settings.
        failed = items.length - i;
        throw e;
      }
      // After atomicEdit's own retry, a remaining conflict means the file
      // already reflects something — last-write-wins. Drop the op.
      if (e instanceof GitHubConflictError) {
        await deleteKey(key);
        flushed++;
        emitChanged();
        continue;
      }
      // Network or unknown — stop, leave remaining ops queued.
      failed = items.length - i;
      break;
    }
  }
  return { flushed, failed };
}
