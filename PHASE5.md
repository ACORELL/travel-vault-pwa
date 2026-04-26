# Phase 5 — Plan: shared-timeline + live writes + appendments + delete

**Current state: Plan drafted, awaiting sign-off. No code changes yet.**
**Next: User reviews decisions D1–D12, then `/effort high` execution session begins.**

---

## 1. Goal

Replace the per-author Phase 4 model with a single shared `days/<date>/timeline.json` per day, write-through on every action (no manual Sync button), auto-refresh on read, append-to-entry contributions, and either-author cascading deletes. The two-author file split goes away — author becomes a per-entry / per-appendment metadata field, not a path segment.

After Phase 5: there's one document per day, both phones read-and-write it directly, the local IDB is a cache of the remote, and any tap-and-edit / tap-and-delete / tap-and-append on either device propagates to the other within seconds. Offline edits queue locally and replay in order on reconnect.

---

## 2. Architecture overview

```
Capture (any device, any time):
  Tap check-in / note / photo / append / edit / delete
    → mutate local cache (optimistic)
    → atomicEdit(date, mutator) push to GitHub
        - getFile(timeline.json)  → { content, sha }
        - JSON.parse, run mutator, JSON.stringify
        - putFile(timeline.json, content, message, sha)
        - on 422: refetch sha, re-run mutator on fresh content, retry once
    → if offline: enqueue op in mutation queue, return
    → on online/foreground: drain mutation queue (sequential)

Read:
  Boot, visibilitychange, 'online', or pull-to-refresh
    → fetchDay(date)
        - getFile(timeline.json) → { content, sha }
        - cache.put(date, { entries, sha, fetchedAt })
        - emit 'day-changed'
    → Renderer reads from cache, renders parent entries with nested appendments

Photos:
  On confirm
    → generate thumb blob via thumbs.generateFromFile
    → thumbs.storeLocal(ref, blob)
    → putFile(days/<date>/thumbs/<ref>, blob)  (direct, no queue)
       - if offline, enqueue thumb-upload op
    → atomicEdit add-entry / add-appendment with ref reference

Delete:
  On confirm
    → compute cascade ids (locally) and pass as a list
    → atomicEdit(date, entries => entries.filter(e => !ids.has(e.id)))
       - mutator returns refs-to-cleanup via closure
    → after success: best-effort delete each thumb (deleteFile on remote, drop local)
```

Per-device serialisation: `atomicEdit` chains writes per-date through an in-memory promise — two rapid taps on the same date can't race themselves, only the cross-device case relies on the sha-retry loop.

---

## 3. Decisions to confirm before code

| # | Decision | Recommend | Why |
|---|---|---|---|
| **D1** | File layout | Single `days/<date>/timeline.json` per day. Drop `timelines/<author>.json`. | What this whole phase is for. |
| **D2** | Concurrency strategy | `atomicEdit` helper: fetch+sha → mutator → PUT with sha; on 422 refetch and re-run mutator once. | Last-write-wins per entry id. Rare same-second same-id collisions accepted (user already confirmed sequential use). |
| **D3** | Per-device serialisation | In-memory promise chain keyed by date (mutex-lite). | Avoids self-races; doesn't help cross-device but the sha retry does. |
| **D4** | Mutation queue | New `services/ops.js`, ordered by enqueue. Each op is `{ kind, date, ...args }`. Drain on boot / online / after refresh. | Offline durability. Replays each op via `atomicEdit` so sha-fresh at flush time. |
| **D5** | Append data model | Nested `appendments: []` array on the parent entry. Each appendment has its own `id`, `author`, `t`, and either `content` or `ref`+`comment`. One level deep — no nested-nested. | Simple to render and reason about; simple delete cascade. |
| **D6** | Edit authorisation | Only the original author can edit a parent or an appendment. | Stops accidental rewrites; matches user intent. |
| **D7** | Delete authorisation | Either author can delete anything. | User-stated. |
| **D8** | Cascade — parent delete | Parent + all its appendments removed in a single mutator pass. Confirm dialog shows count, breaks down by author. | "Delete photo and 2 from A?" |
| **D9** | Cascade — check-in delete | Check-in + every entry whose `t` falls between this check-in's `t` and the next check-in's `t` (or end-of-day). Their appendments go too. Confirm shows total count. | Matches "delete check-in deletes the group". Cascade ids computed from local cached state at confirm time, not at flush time, so the dialog count = the actual deletion. |
| **D10** | Thumb cleanup on delete | Best-effort: after the atomicEdit succeeds, delete each removed entry/appendment's thumb (local + remote via `deleteFile`). Failure non-fatal — orphan thumbs are harmless. | Keeps the repo tidy; doesn't risk losing the timeline mutation if the thumb DELETE fails. |
| **D11** | Refresh triggers | Boot, `visibilitychange` → visible, `online` event, pull-to-refresh (button — see D12). All converge on `fetchDay(s.viewedDate)`. Throttle to once per 10 s. | "Live" feel without API hammering. |
| **D12** | Pull-to-refresh control | Button labelled "Refresh" in the existing sync-row (where "Sync now" lived); auto triggers also fire it. Last-refreshed timestamp shown beside it. **Not** the browser's native pull-down (conflicts with scroll on Android Chrome). | Reliable across devices; one canonical surface. |

Also locking in (no real choice):
- Author letter (`N`/`A`) stays in `localStorage`, set per device on first launch. No longer in the file path.
- Hard cutover. Trip hasn't started. Bumping IDB version drops legacy stores; legacy `timelines/<author>.json` files in the repo are orphaned, ignored, deleted manually if you want a clean repo (instructions in section 11).
- "Sync now" button removed.
- Phase 4 sync-state localStorage (`tv-sync-state`, `timelineSha` map) removed — sha fetched fresh on each write.

---

## 4. timeline.json schema (locked in via D1, D5)

```json
[
  { "id": "143022_N", "type": "checkin", "author": "N",
    "t": "2026-04-25T14:30:22",
    "gps": { "lat": 38.7189, "lon": -9.1355 } },

  { "id": "143030_N", "type": "note", "author": "N",
    "t": "2026-04-25T14:30:30",
    "gps": { "lat": 38.7189, "lon": -9.1355 },
    "content": "Stopped for coffee at the kiosk",
    "appendments": [
      { "id": "143511_A", "author": "A",
        "t": "2026-04-25T14:35:11",
        "gps": { "lat": 38.7190, "lon": -9.1354 },
        "content": "Best one was the second course" }
    ] },

  { "id": "143045_N", "type": "photo", "author": "N",
    "t": "2026-04-25T14:30:45",
    "gps": { "lat": 38.7189, "lon": -9.1355 },
    "ref": "2026-04-25_143045_N.jpg",
    "comment": "the harbour",
    "appendments": [
      { "id": "143612_A", "author": "A",
        "t": "2026-04-25T14:36:12",
        "gps": { "lat": 38.7191, "lon": -9.1352 },
        "ref": "2026-04-25_143612_A.jpg",
        "comment": "got this angle" }
    ] }
]
```

Rules:
- Top-level array sorted by `t` ascending. Renderer relies on this.
- `id` is `HHMMSS_<author>` from `t`'s local time. Collisions within the same second on the same device get a `_<n>` suffix appended (rare, defensive).
- `author` is mandatory on every parent and every appendment.
- `appendments` is optional on parent entries; if absent, treated as `[]`. Always absent on appendments themselves (no nesting beyond one level — D5).
- Empty day = `[]`. File created on first write.
- Thumbnail path: `days/YYYY-MM-DD/thumbs/<ref>` — unchanged from Phase 4.

---

## 5. Atomic edit helper

```
services/timeline.js
  atomicEdit(date, mutator)
    Per-date in-memory promise chain prevents intra-device self-races.
    Body:
      for attempt in 0..1:
        try { current, sha } = await getFile(timeline.json)   // or [] if 404
        let next = mutator(current)                           // mutator may close over outputs
        try { await putFile(timeline.json, JSON.stringify(next, null, 2), msg, sha) }
        catch (GitHubConflictError) { continue }              // refetch + retry once
        await cache.put(date, { entries: next, sha: response.sha, fetchedAt: now })
        emit 'day-changed' { date }
        return next
      throw GitHubConflictError                               // gave up after 1 retry
```

Mutator examples (named exports for the UI to call):

| Caller | Mutator | Notes |
|---|---|---|
| `addEntry(date, entry)` | `xs => [...xs, entry].sort(byT)` | new top-level entry |
| `editEntry(date, id, patch)` | `xs => xs.map(e => e.id===id ? {...e, ...patch} : e)` | parent edit |
| `deleteEntry(date, id, refSink)` | `xs => { collect refs of e.id===id and its appendments into refSink; return xs.filter(e => e.id!==id) }` | parent + appendments removed |
| `addAppendment(date, parentId, app)` | `xs => xs.map(e => e.id===parentId ? {...e, appendments:[...(e.appendments||[]), app].sort(byT)} : e)` | append |
| `editAppendment(date, parentId, appId, patch)` | nested map | appendment edit |
| `deleteAppendment(date, parentId, appId, refSink)` | nested filter | appendment delete |
| `deleteMany(date, idsToRemove, refSink)` | `xs => xs.filter(e => !ids.has(e.id))` | check-in cascade |

`refSink` is a closure-captured array — the mutator pushes ref strings of anything it removes, the caller does best-effort thumb cleanup after the atomicEdit returns (D10).

Failure modes:
- `GitHubAuthError` → propagate; UI redirects to settings.
- Network error → mutation goes to the offline ops queue (`services/ops.js`). UI considers the local optimistic update authoritative and re-renders.
- `GitHubConflictError` after one retry → propagate; surface to UI as "conflict, retry?".

---

## 6. Mutation queue (`services/ops.js`)

Owns its own IDB store `tv-ops / queue` (autoincrement). Each item:

```json
{ "kind": "add-entry" | "edit-entry" | "delete-entry"
        | "add-appendment" | "edit-appendment" | "delete-appendment"
        | "delete-many"
        | "put-thumb" | "delete-thumb",
  "date": "YYYY-MM-DD",
  "args": { ... } }
```

API:

```
enqueue(op)            → void   appends, emits 'ops-changed'
count()                → number
flush()                → { flushed, failed }
                                Sequential, insertion order. On success, deletes
                                from store. On GitHubConflictError after replay's
                                own retry, treat as success and drop (the file
                                state already reflects something — last-write-
                                wins). On GitHubAuthError, throw and stop.
                                On network failure, stop. Caller decides retry.
clear()                → void   for resetApp
```

Trigger points (same as Phase 4 queue):
- App boot, `online` event, settings save, settings test pass, after every successful direct write (so any backlog drains opportunistically).

Design note: ops **dispatch to the same atomicEdit / putFile / deleteFile primitives** the UI calls. The replayer is just a `switch (op.kind)` over named timeline.js exports. No duplicated mutation logic.

---

## 7. Refresh / read path (`services/refresh.js`)

```
fetchDay(date) → entries
  Reads days/<date>/timeline.json. 404 → []. Caches in
  tv-timeline / day-cache by date. Emits 'day-changed' with { date }.
  Throttled: at most one fetch per (date) per 10 s unless `force = true`.

lastRefreshedAt() → ISO string | null
  For UI display.

isAutoRefreshDue() → boolean
  Throttle for foreground/online auto-triggers (same 10 s window).
```

Trigger points:
- App boot — `fetchDay(TODAY)` after settings init and `s.viewedDate` defaults to TODAY.
- `visibilitychange` → visible — refetch `s.viewedDate` if `isAutoRefreshDue`.
- `online` event — refetch `s.viewedDate`.
- Manual "Refresh" button — refetch `s.viewedDate` with `force=true`.
- After day navigation (prev/next) — fetchDay for the new date.
- After every successful local write — already populates the cache via atomicEdit's tail; no extra refetch needed.

Render path: `loadLog()` reads from `day-cache` for `s.viewedDate`, sets `s.logEntries`, renders. Cache miss falls back to `fetchDay`.

---

## 8. Capture path (the new write surface)

`tabs/log/log.js` exposes one function per user gesture. Each one:

1. Builds the entry / appendment / patch.
2. Optimistically updates `s.logEntries` and re-renders. (The UI is snappy — no spinner.)
3. Calls the appropriate `timeline.js` mutator. If it throws a network error, enqueue. If it throws auth, surface.
4. For photo paths: thumb upload (direct `putFile`) **before** the entry mutation. If thumb fails (non-auth), enqueue both ops (thumb first, entry second — order preserved).

Functions:

| Function | Mutator call | Compose-state kind |
|---|---|---|
| `addCheckin()` | `addEntry(date, checkinEntry)` | n/a (one-tap) |
| `addNote()` (form save) | `addEntry(date, noteEntry)` | `add-note` |
| `addPhoto()` (form save) | thumb PUT + `addEntry(date, photoEntry)` | `add-photo` |
| `editEntry(id, patch)` (form save) | `editEntry(date, id, patch)` | `edit-note` / `edit-photo` |
| `deleteEntry(id)` | `deleteEntry(date, id, sink)` then thumb cleanup | n/a (confirm dialog) |
| `addAppendment(parentId)` (form save) | `addAppendment(date, parentId, app)` | `append-note` / `append-photo` |
| `editAppendment(parentId, appId, patch)` | `editAppendment(...)` | `edit-appendment-*` |
| `deleteAppendment(parentId, appId)` | `deleteAppendment(...)` then thumb cleanup | n/a |
| `deleteCheckinGroup(checkinId)` | `deleteMany(...)` then thumb cleanup | n/a |

Composing state (replaces piecemeal `editingId`/`editingType`):

```
s.composing = null
            | { kind: 'add-note' }
            | { kind: 'add-photo' }
            | { kind: 'edit-note', entryId }
            | { kind: 'edit-photo', entryId }
            | { kind: 'append-note', parentId }
            | { kind: 'append-photo', parentId }
            | { kind: 'edit-appendment-note', parentId, appId }
            | { kind: 'edit-appendment-photo', parentId, appId }
```

`s.viewingEntry: entryId | null` tracks the detail-view sheet (section 9). Independent of `composing`.

`s.pendingPhoto`, `s.pendingDraft`, `s.editingId`, `s.editingType` are dropped — `composing` covers all of it.

Proximity check stays as today: looks for the most recent `type === 'checkin'` in `s.logEntries`. Since `s.logEntries` is now the merged-shared timeline, the check naturally considers either author's check-ins.

---

## 9. Detail view UI

Tap any entry in the log → opens a full-screen sheet (`#entry-detail`) showing the parent, then its appendments, then an action bar.

Markup outline:

```html
<div id="entry-detail" class="fsform hidden">
  <div class="fshdr">
    <button id="entry-detail-close">Close</button>
    <h3 id="entry-detail-title">Photo · 14:30 · N</h3>
  </div>
  <div class="fsbody">
    <div id="entry-detail-parent">    <!-- parent entry rendered large --></div>
    <div id="entry-detail-actions">   <!-- [Edit] [Delete] for parent --></div>
    <hr class="entry-detail-divider">
    <div id="entry-detail-appendments">
      <!-- one .appendment per item:
           [author-badge] HH:MM [content or thumb+comment] [Edit?] [Delete] -->
    </div>
  </div>
  <div class="entry-detail-bottom">
    <button id="entry-detail-add-comment">+ Comment</button>
    <button id="entry-detail-add-photo">+ Photo</button>
  </div>
</div>
```

Interaction rules:
- **Edit** button visible only if the entity's `author === s.author`.
- **Delete** button always visible (D7).
- **Confirm dialogs**: cascade deletes show a count + breakdown:
  - Parent with appendments: `Delete this photo and 2 contributions (1 from A, 1 from N)?`
  - Parent without appendments: `Delete this note?`
  - Check-in: `Delete this check-in and 7 entries (4 yours, 3 from A) below it?`
  - Appendment: `Delete your comment?` / `Delete A's comment?`
- **+ Comment** opens `note-form` with `s.composing = { kind: 'append-note', parentId }`. Save calls `addAppendment`.
- **+ Photo** triggers `#photo-input.click()` with `s.composing = { kind: 'append-photo', parentId }`. Photo flow then opens `photo-form` and Save calls `addAppendment`.
- **Edit** on the parent or an appendment opens the matching form prefilled with `s.composing = { kind: 'edit-*', ... }`. Save dispatches the right mutator.
- **Photo replace** in an edit photo flow — same ref reused, thumb regenerated and re-PUT, `editAppendment`/`editEntry` updates `comment` if changed.
- The detail view re-renders on `'day-changed'` so live edits from the other device land while it's open.

CSS: `.appendment` cards are tinted by author (reuses `AUTHOR_COLORS[a].tint`), with the author letter as a small badge to the left.

Tap-to-open replaces the Phase-4 tap-to-edit. There's no separate "tap to edit" affordance — opening the detail view is the gateway.

---

## 10. Delete + cascade

Cascade-id computation runs from the **local cached state** at confirm time:

```
function cascadeIdsForCheckin(checkinId, entries):
  sorted = entries.sort by t
  i = sorted.findIndex(e => e.id === checkinId && e.type === 'checkin')
  next = sorted.slice(i+1).find(e => e.type === 'checkin')
  upper = next ? next.t : '￿'
  return sorted.filter(e => e.t > sorted[i].t && e.t < upper).map(e => e.id)

function appendmentCount(entry):
  return (entry.appendments || []).length
```

Confirm:
- **Parent (non-checkin) with N appendments**: `Delete this {type} and {N} contributions ({nN} from N, {nA} from A)?`
- **Parent (non-checkin) with no appendments**: `Delete this {type}?`
- **Check-in with K entries below**: `Delete this check-in and {K} entries ({your} yours, {their} from {other})?`
- **Appendment**: `Delete this comment{/photo} from {author}?`

On confirm:
- Build `idsToRemove` (parent + its appendments, or checkin + cascade list, or just the appendment).
- Build `refsToCleanup` from each removed item that has a `ref`.
- Run the appropriate mutator (`deleteEntry`, `deleteAppendment`, or `deleteMany`).
- After atomicEdit returns: for each ref in `refsToCleanup`, best-effort `thumbs.deleteLocal(ref)` + `github.deleteFile(thumbs/<ref>, sha)`. Failures swallowed.

Per D9, the cascade list is computed at confirm time and passed verbatim to `deleteMany`. Even if another device adds entries between confirm and PUT, only the ids the user actually saw get removed. Newly-added entries by the other device survive. (If they happen to fall in the same time window, they'd be visible on the next refresh and the user can choose to delete them too — explicit, predictable.)

---

## 11. Migration (hard cutover)

Trip hasn't started; user has confirmed earlier that Phase-4 test data is disposable.

**On-device (automatic):**
- IDB version of `tv-timeline` bumps to 2. `onupgradeneeded` deletes old `timeline-local` and `timeline-cache` stores, creates `day-cache` (single store, keyPath `date`).
- `tv-thumbs` IDB stays at v1. `thumbs-local` keeps its current data (own thumbs continue rendering after migration). `thumbs-sync-state` store is no longer read or written, but isn't deleted on the upgrade — deferred housekeeping only, harmless.
- `localStorage` keys: `tv-sync-state` is removed by the new `app.js` boot path. `tv-author` / `tv-github-pat` / `tv-github-repo` / `tv-worker-url` keep their meanings.

**Repo-side (manual, optional):**
- Phase-4 `days/<date>/timelines/<author>.json` files become orphans. The new code never reads them. To clean up:
  - From a local clone: `git rm -r days/` then commit + push, OR
  - Use the GitHub web UI to delete the `days/` tree, OR
  - Add a one-off "Wipe trip data" button in settings that walks `days/` and DELETEs everything (deferred — only do this if asked; not in scope for v46).
- Existing thumbnail blobs in `days/<date>/thumbs/` are still valid if their refs survive into the new schema (they won't, post-cleanup).

**Data-loss accepted:** any captures sitting in Phase-4 `timelines/<author>.json` are *not* migrated to the new shared file. This was confirmed when the trip was decided not to have started yet.

---

## 12. File-by-file delta

| File | Action |
|---|---|
| `pwa/phone/services/timeline.js` | **Rewrite.** New IDB schema (`day-cache` store, version 2, drop `timeline-local`/`timeline-cache`). New atomicEdit + named mutators. Per-date promise-chain mutex. |
| `pwa/phone/services/ops.js` | **NEW** — section 6. |
| `pwa/phone/services/refresh.js` | **NEW** — section 7. |
| `pwa/phone/services/sync.js` | **DELETE.** Replaced by atomicEdit + ops.js + refresh.js. |
| `pwa/phone/services/thumbs.js` | Drop `thumbs-sync-state` store usage and `markSynced`/`markUnsynced`/`unsyncedRefs`. Keep `generateFromFile`, `storeLocal`, `getLocalBlob`, `getLocalUrl`. Add `deleteLocal(ref)` for delete cascade. |
| `pwa/phone/services/restore.js` | **Rewrite.** Pull `days/<date>/timeline.json` for every date in `listDir('days')`, hydrate `day-cache`, then for every entry/appendment with a `ref`, fetch `thumbs/<ref>` and store via `thumbs.storeLocal`. |
| `pwa/phone/services/queue.js` | Stays (handles raw wiki captures only). Untouched. |
| `pwa/phone/services/github.js` | Untouched (Phase 4 putFile binary support already covers thumb uploads). |
| `pwa/phone/tabs/log/log.js` | **Rewrite** the capture / read paths. Add `addCheckin`, `addNote`, `addPhoto`, `editEntry`, `deleteEntry`, `addAppendment`, `editAppendment`, `deleteAppendment`, `deleteCheckinGroup`. Drop the `editingId`/`editingType`/`pendingPhoto`/`pendingDraft` fields in favour of `s.composing`. Drop the `syncQueue` / `checkConflicts` no-op stubs (still called from app.js? — see app.js row). Sync UI button becomes "Refresh" calling `refresh.fetchDay`. |
| `pwa/phone/tabs/log/log-ui.js` | Render appendments under each parent. Tap-to-open replaces tap-to-edit. Drop the `.editable` cursor styling — every entry is now tappable to open the detail view. |
| `pwa/phone/tabs/log/detail.js` | **NEW.** Detail view rendering, action wiring (Edit / Delete / +Comment / +Photo). Forms still come from `index.html`'s existing `note-form` / `photo-form`. |
| `pwa/phone/index.html` | Add `#entry-detail` markup and CSS (section 9). Adjust `#sync-row`: rename the button to "Refresh" with `id="btn-refresh"`. Drop `id="btn-sync"` / `#last-synced-label` and replace with `#btn-refresh` / `#last-refreshed-label`. Photo form gains nothing new (already has #photo-replace from Phase 4 polish). |
| `pwa/phone/core/state.js` | Add `composing: null`, `viewingEntry: null`. Drop `pendingPhoto`, `pendingDraft`, `editingId`, `editingType`. Keep `logEntries`, `viewedDate`, `availableDays`, `author`, `syncStatus`. |
| `pwa/phone/app.js` | Drop the `logTab.syncQueue()` no-op call site (no longer exists). Replace `logTab.autoSync` with `refresh.maybeRefresh` triggered by visibility/online. Settings restore now invalidates `day-cache` on completion. |
| `pwa/phone/sw.js` | SHELL: add `./services/ops.js`, `./services/refresh.js`, `./tabs/log/detail.js`; remove `./services/sync.js`. CACHE bump. |
| `pwa/phone/settings/settings-ui.js` | "Restore from repo" button stays; its handler now calls the rewritten `restore.restoreFromRepo`. No UI change beyond that. |
| `pwa-structure.md` (outer) | Replace timeline/thumbs/sync blocks with the new shapes. Phase line → "5 done". |
| `REARCHITECTURE.md` (outer) | Mark Phase 5 ✅ SHIPPED on deploy. |
| `PROGRESS.md` (outer) | Append entry. |
| `pwa/phone/PHASE5.md` | This file — recovery doc. |

---

## 13. Step ordering — one commit per step

| # | Step | Files | Verifiable end-state |
|---|---|---|---|
| 0 | **Plan committed** | `PHASE5.md` only | This file on disk, sign-off captured in section 17 |
| 1 | **`services/timeline.js` rewrite + IDB v2** | `services/timeline.js`, `sw.js` (SHELL stays) | `node --check` passes; nothing imports the new exports yet |
| 2 | **`services/ops.js`** | `services/ops.js` (new), `sw.js` (SHELL +) | Standalone module ready |
| 3 | **`services/refresh.js`** | `services/refresh.js` (new), `sw.js` (SHELL +) | Wires timeline.js + day-cache + github.js. Standalone. |
| 4 | **`services/thumbs.js` simplification** | `services/thumbs.js` | Drops sync-state APIs; adds `deleteLocal`. No callers updated yet. |
| 5 | **`services/restore.js` rewrite** | `services/restore.js` | New schema-aware pull. Settings UI continues to call same export name. |
| 6 | **`tabs/log/log.js` capture + read rewrite** | `tabs/log/log.js`, `tabs/log/log-ui.js` (entry render with appendments), `core/state.js` (composing/viewingEntry; drop legacy) | Tap check-in / note / photo writes through atomicEdit. Refresh button fetches. Tap on an entry doesn't open detail yet (step 7). |
| 7 | **Detail view scaffolding** | `tabs/log/detail.js` (new), `index.html` (markup + CSS), `tabs/log/log-ui.js` (wire tap-to-open) | Tap an entry → sheet opens, parent + appendments visible. No actions yet. |
| 8 | **Edit + Delete actions in detail view** | `tabs/log/detail.js`, `tabs/log/log.js` (deleteEntry, deleteAppendment, deleteCheckinGroup, editEntry, editAppendment) | Edit own entries (parent + appendments). Delete anything with cascade-confirm. |
| 9 | **Append actions** | `tabs/log/detail.js`, `tabs/log/log.js` (addAppendment) | + Comment / + Photo from inside detail view. |
| 10 | **Auto-refresh wiring + Refresh button** | `app.js` (visibility/online → refresh.maybeRefresh), `tabs/log/log.js` (Refresh button → refresh.fetchDay) | Cross-device write visible after a refresh tick. |
| 11 | **Delete `services/sync.js`; clean app.js dead code** | `services/sync.js` (delete), `app.js`, `sw.js` SHELL | `grep -r 'services/sync' pwa/phone/` empty |
| 12 | **Standards updates** | `pwa-structure.md` (outer), `PHASE5.md` state line | Standards reflect new structure |
| 13 | **Deploy v46** | `app.js` VERSION → 46, `sw.js` CACHE → `tv-phone-v46`, fresh-clone push | v46 active on phone; manual smoke test passes the done-when list |
| 14 | **PROGRESS log** | `PROGRESS.md`, `REARCHITECTURE.md` | Phase 5 ✅ |

Each step `node --check`s on save. Steps 1–5 are additive (no callers); 6–10 cut over the UI. Steps 11–14 cleanup + ship.

---

## 14. Risks and pre-empts

| Risk | Mitigation |
|---|---|
| **Cross-device write race** during atomicEdit. | sha-refetch-and-retry inside `atomicEdit`. Mutator re-runs on the latest content, so add/edit/delete by id is naturally idempotent in the merge step. |
| **Mutator runs against stale state on retry**. | Mutators are written to be commutative for unrelated ids and last-write-wins for same id. Re-running on fresh content gives the right answer in both cases. |
| **Cascade race**: another device adds an entry to a check-in's group between confirm and push. | D9: cascade ids are fixed at confirm time. The new entry survives; user sees it on next refresh and can decide. |
| **Offline ops queue desync**: ops queued, push fails, app reloads, ops still in queue. | Ops queue is in IDB; survives reloads. Drained on boot. Each replay is via atomicEdit (sha-fresh) so order matters but stale snapshots don't. |
| **Auth error mid-flush**. | Ops queue stops draining; surface to UI, redirect to settings. On settings save, drain triggers again. |
| **Thumb upload + entry add ordering**. | Thumb first, entry second. Same as Phase 4. If thumb fails, entry is queued *after* the thumb op so order is preserved on flush. |
| **Detail view open while other device deletes the entry**. | Detail view subscribes to `'day-changed'`. On change, if `s.viewingEntry` no longer exists in the cache, close the sheet with a small toast: "This entry was deleted on another device." |
| **Same-second same-device id collision** (rare bursts). | `id = HHMMSS_<author>` with `_<n>` suffix on collision (collision detected by checking local cache before write). |
| **Migration: old `timelines/<author>.json` files in repo**. | Ignored. Manual cleanup documented in section 11. |
| **Storage pressure evicts day-cache**. | `navigator.storage.persist()` is already requested. Cache miss falls through to network — no data loss. |
| **Optimistic UI inconsistent with server**. | After every mutation, the atomicEdit's tail re-caches. After every refresh, the cache is the truth. Window of inconsistency is one round-trip; fine. |
| **PUT message-body size**: a busy day with many photo entries + appendments could grow the timeline.json. | KB-scale even at 100 entries with appendments. Negligible. |
| **deleteFile failure on thumb cleanup**. | Best-effort, swallowed. Orphan thumbs are visible only via `listDir('days/<date>/thumbs')`. Optional: add a "Repo housekeeping" button later. Not in scope. |

---

## 15. Done-when criteria

1. App boots without prompting for anything beyond first-launch author + settings.
2. Tap check-in → entry appears in log immediately. Within ~2 s, the entry shows on the other device after a refresh.
3. Tap note → entry visible immediately, propagates within ~2 s after refresh.
4. Tap photo → preview shown, comment confirmed, thumb pushed, entry visible immediately, propagates ~2 s after refresh.
5. Tap an entry → detail view opens with parent + appendments + action bar.
6. + Comment in detail view from device A on device B's photo → appendment with `A` badge appears in B's detail view on next refresh.
7. + Photo in detail view from device A on device B's note → photo appendment appears.
8. Edit own note (parent or appendment) → wording updates everywhere.
9. Edit own photo's comment → updates everywhere; thumb unchanged.
10. Edit own photo with Replace → new thumb on remote, comment optionally changed; both devices see the new image after refresh.
11. Delete own note → confirm shows count → entry gone; appendments removed if any. Other device sees deletion after refresh.
12. Delete other-author's appendment to own note → confirm shows author → entry stays, just that appendment removed.
13. Delete check-in → confirm shows total + author breakdown → check-in and the entries between it and the next check-in are removed; appendments cascade. Both devices see the cleanup.
14. Offline capture: airplane mode → tap check-in → entry appears immediately. Toggle online → entry pushes; observable in repo within seconds.
15. Offline edit/delete: same flow, drains in order on reconnect.
16. Refresh button updates `last refreshed HH:MM` and re-fetches the day's timeline.
17. Pull-to-refresh equivalent (tap Refresh) works on past days too.
18. Settings → Restore from repo: pulls everything, log tab populates, photos render.
19. SW cache `tv-phone-v46` is the active version on the phone.
20. `services/sync.js` not in repo.

---

## 16. Out of scope for Phase 5

- Repo housekeeping UI ("Wipe trip data" / "Cleanup orphan thumbs"). Manual via gh/git.
- Legacy Phase-4 data migration (`timelines/<author>.json` → `timeline.json`). Hard cutover only.
- Real-time push notifications between devices (still pull-based; user taps Refresh or app foregrounds).
- Conflict UI for the rare same-second same-id case — last-write-wins, silent.
- Editing other-authored entries (D6 — only original author edits).
- Nested-nested appendments (D5 — one level).
- Worker / Phase 6 assembly PWA — separate scopes.

---

## 17. Pre-execution checklist

Before kicking off the execution session at `/effort high`:

- [ ] User confirms decisions D1–D12.
- [ ] User confirms step ordering (14 commits) is acceptable.
- [ ] User confirms hard cutover (Phase-4 data discarded; trip-not-yet-started still true).
- [ ] User confirms manual repo cleanup of `days/` is OK to do post-deploy (or wants the optional in-app "Wipe trip data" button — would add a step).
- [ ] PHASE5.md committed first (step 0).
- [ ] Confirm GitHub PAT still has `Contents: read+write` on `acorell/travel-vault-data` (unchanged from Phase 4).
- [ ] Confirm both devices are on v45+ before deploying v46 (so the migration's IDB upgrade runs cleanly).
