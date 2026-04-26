# Phase 4 — Plan: capture PWA backend rewrite (FSA → local-first + deferred GitHub sync)

**Current state: Plan drafted, not yet confirmed for execution. No code changes yet.**
**Next: User reviews decisions D1–D8, then `/effort high` execution session begins.**

---

## 1. Goal

Replace the FSA-backed log/photo data path with a local-first capture model that defers publishing to GitHub. Each device captures into its own IndexedDB store; an explicit "Sync now" action (with auto-triggers on foreground/online) batch-publishes the day's entries to `days/YYYY-MM-DD/timelines/<author>.json` in the private data repo, alongside web-quality thumbnails for photos. Full-resolution photos stay on the capture phone's camera roll and are never uploaded — they're picked up at home by a separate assembly PWA (Phase 6) for the book.

After Phase 4: no Obsidian, no Google Photos integration in the live data path, no cross-device write race, no append-merge logic. `services/vault.js`, `db.js`, the vault-setup overlay, the conflict banner, and `s.vault` are all gone. The only on-device storage is IndexedDB; everything authoritative for cross-device read lives in `acorell/travel-vault-data`.

This is a backend swap and a UX shift:
- **Capture is offline-first.** No network, no auth errors, no offline queue at the capture path.
- **Sync is explicit-or-opportunistic.** Not realtime; user-initiated or auto on foreground/online.
- **Photos render as placeholders on other devices.** Each phone shows its own photos (from local FSA on its own camera roll) but renders the other phone's photo entries as text+coords until the assembly PWA at home pairs them with full-res bytes.

---

## 2. Architecture overview

```
Capture (each phone, offline-first):
  Tap check-in / note / photo
    → write entry to IndexedDB store 'timeline-local' keyed by (date, author)
    → for photos: also generate web-quality thumbnail via <canvas>, store in IDB

Render own timeline (always available):
  Log tab reads timeline-local for today (own entries)
  Plus union with cached fetch of other-author's timeline from last sync

Sync (manual or auto):
  Trigger: "Sync now" button OR app foregrounded OR 'online' event
    For today's date:
      Read timeline-local entries for (today, self-author)
      Compose timelines/<author>.json content (full file replacement, not append)
      Compose thumbs payload for photo entries
      PUT days/YYYY-MM-DD/timelines/<author>.json
      PUT days/YYYY-MM-DD/thumbs/<HHMMSS_author>.jpg per photo (creates only)
    Mark synced (timestamp + counts in IDB)

Cross-device read (when online):
  Log tab can refetch the other author's timelines/<author>.json on demand
  Photos from the other author render as placeholder + GPS + comment until home
```

Per-author files eliminate the cross-device write race entirely — different paths, different shas, different commit streams. Each device writes only to its own `<author>.json`.

---

## 3. Decisions to confirm before code

| # | Decision | Recommend | Why |
|---|---|---|---|
| **D1** | Cross-device append semantics | Per-author files (`timelines/N.json`, `timelines/A.json`); each device owns one. **No merge logic.** | Different paths = no race. `putFile`'s sha-refetch retry is sufficient — only one writer per file. |
| **D2** | Offline queue | `services/queue.js` stays creates-only per `pwa-structure.md`. Photo thumbnails (creates only, unique paths) flow through it. Timeline `<author>.json` is a full-file PUT on sync; if it fails, the local store is the recovery — retry on next sync. **No queue extension.** | Queue contract preserved. Local-first means the IDB capture store *is* the durable buffer; GitHub queue isn't needed for capture. |
| **D3** | Timeline entry author field | **Drop.** File path encodes author. | One less field, one less source of truth. |
| **D4** | Photo entry id collision | `id = HHMMSS_<author>` | Cheap uniqueness; defends against rare same-second collisions. |
| **D5** | Photo capture UI | Camera-only (`capture="environment"`), comment-only confirmation form, **no preview**. Thumbnail is generated silently via `<canvas>` on confirm. | Closes STRUCTURE.md Issue 1 by removal. Smaller diff. The thumbnail is what other devices and the assembly PWA see — preview during capture isn't load-bearing. |
| **D6** | `db.js` fate | **Delete.** Move schema declarations into `services/queue.js` (raw-queue) and `services/timeline.js` (timeline-local + timeline-cache + thumbs-cache). | Clean break with FSA era. |
| **D7** | `s.vault` field | **Delete from `core/state.js`.** | No longer used. |
| **D8** | Migration of existing local `log.md` | **Accept loss.** Trip hasn't started. | Migration would re-introduce FSA in the same phase that removes it. |

Decisions deferred from the prior plan that are now obsolete:
- ~~Cross-device merge inside `services/timeline.js`~~ — gone (D1).
- ~~Queue extension for timeline appends~~ — gone (D2).

---

## 4. timeline.json schema (locked in via D3, D4)

```json
[
  { "id": "143022_N", "type": "checkin",
    "gps": { "lat": 38.7189, "lon": -9.1355 },
    "t": "2026-04-25T14:30:22Z" },

  { "id": "143030_N", "type": "note",
    "content": "Stopped for coffee at the kiosk",
    "t": "2026-04-25T14:30:30Z" },

  { "id": "143045_N", "type": "photo",
    "ref": "2026-04-25_143045_N.jpg",
    "comment": "the harbour",
    "gps": { "lat": 38.7189, "lon": -9.1355 },
    "t": "2026-04-25T14:30:45Z" }
]
```

- File path: `days/YYYY-MM-DD/timelines/<author>.json` (one per author per day).
- `ref` matches the thumbnail filename and the EXIF timestamp on the camera roll's full-res JPEG.
- Empty day = `[]`.
- Sort key for render = `t`.
- Thumbnails at `days/YYYY-MM-DD/thumbs/<HHMMSS_author>.jpg`, ~200 KB each.

Storage math sanity check (from the chat exploration):
- 30-day trip × 50 photos/day × 200 KB thumb = ~300 MB total → comfortable under GitHub's 5 GB recommendation.
- Timeline JSON itself: KB-scale, negligible.
- Full-res photos: stay on the capture phone, **not in the repo**.

---

## 5. Thumbnail generation

On photo entry confirm (after camera capture + comment):
1. Read the `File` blob from `<input>`.
2. Draw to an offscreen `<canvas>` at long-edge 1600px (preserves aspect ratio).
3. Export as JPEG quality 75 → ~150–250 KB blob.
4. Store the thumbnail blob in IDB `thumbs-local` keyed by `ref`.
5. Append the photo entry to `timeline-local`.
6. On next sync: PUT each thumb as a separate file under `days/YYYY-MM-DD/thumbs/<ref>`. Creates only. Goes through `services/queue.js` as a normal raw-queue item.

The full-res `File` is NOT stored anywhere by the PWA — Android's `capture="environment"` saves it to the camera roll, which is the source of truth for the assembly PWA at home.

---

## 6. Sync mechanics

The sync surface is small and explicit:

```
services/sync.js
  syncToday() → { author, entriesUploaded, thumbsUploaded, errors }
    1. Read timeline-local for (TODAY, self-author).
    2. Compose timelines/<self>.json full content (entries array).
    3. PUT timelines/<self>.json (with sha if previously synced today, else create).
    4. For each photo entry whose thumb hasn't been pushed yet:
         queue.enqueue({ path: thumbs/<ref>, content: thumbBytes, message: ... })
    5. queue.flush() to drain thumb creates.
    6. Update local sync state in IDB.
```

Triggers:
- **Manual button** in the log tab: "Sync now" with last-sync timestamp shown beneath.
- **Foreground:** when the app comes back to foreground after being backgrounded for >N minutes.
- **`online` event:** if the last sync attempt failed due to network.

Offline / failed sync: local state is unchanged, retry on next trigger. There's no per-entry queue for timelines — the local store *is* the buffer, the sync rewrites the whole day's file each time. Idempotent.

Retroactive edits (rare, but covered): if the user edits an entry locally after sync, the next sync re-PUTs the file with the updated content. The sha-refetch in `putFile` handles the case where the previously-synced sha changed (shouldn't happen for per-author files, but defensive).

---

## 7. Cross-device read

Reading the *other* author's timeline:

```
services/timeline.js
  getOtherTimeline(date, otherAuthor) → Entry[]
    GET days/<date>/timelines/<otherAuthor>.json (404 → [])
    Cache result in timeline-cache keyed by (date, author)
    Return entries
```

Render in the log tab: union-and-sort by `t` of own entries (from `timeline-local`) plus other entries (from cache or fresh fetch). Other-device photo entries render as text placeholder with GPS + comment + ref filename — no thumbnail fetch from GitHub during the day (saves bandwidth and complexity). The thumbnails are still in the repo for the assembly PWA at home.

If we want thumbnails of the other device's photos *during* the trip (nice-to-have), that's a small extension: `getOtherThumb(ref)` fetches `thumbs/<ref>` and caches the blob in IDB. Could ship as a follow-up to Phase 4 if useful; not part of the core.

---

## 8. FSA call inventory → replacement

Every `vault.*` call in `tabs/log/log.js` and `tabs/log/log-ui.js`:

| Caller (file:line) | Today (vault.js) | Replacement |
|---|---|---|
| `log.js:28` `syncQueue` | `vault.appendLogLines` | **Retired.** No FSA queue path. `services/sync.js` handles batch publish. |
| `log.js:29` `syncQueue` | `vault.savePhoto` | **Retired.** No binary writes anywhere. |
| `log.js:234–235` `finishPhotoWrite` | `vault.savePhoto` + `vault.appendLogLines` | `timeline.appendLocal(entry)` + `thumbs.storeLocal(ref, blob)`. |
| `log.js:249` `resolvePhotoName` | `vault.photoExists` | **Retired.** `id`/`ref` derived from timestamp + author per D4. |
| `log.js:255` `writeLogLine` | `vault.appendLogLines` | `timeline.appendLocal(entry)`. |
| `log.js:266` `loadLog` | `vault.readLogMd` + `parseLogMd` | `timeline.getCombined(s.viewedDate)` → own (local) ∪ other (cached/fetched), sorted. |
| `log.js:271` `loadLog` | `getLogQueue` overlay | **Retired.** `timeline-local` is the live store. |
| `log.js:321` `loadAvailableDays` | `vault.listDayFolders` | `timeline.listAvailableDates()` → `listDir('days')`. |
| `log.js:338` `checkConflicts` | `vault.detectConflicts` | **Retired.** No sync-conflict files. |
| `log-ui.js:50` `renderLog` (photo branch) | `vault.getPhotoUrl` | For own entries: read thumb blob from `thumbs-local` IDB store, `URL.createObjectURL`. For other entries: text placeholder. |
| Imports in `log.js`/`log-ui.js` | `vault`, `db.js`'s log-queue exports | **Retired.** |

Proximity helpers (`haversineMetres`, `getLastCheckinGps`, `sampleGpsForProximity`, `checkProximity`) are **untouched** — they read `s.logEntries[*].gps` which still exists on checkin entries.

---

## 9. New modules

### `services/timeline.js`

```
appendLocal(entry) → void
  Push to IDB 'timeline-local' store, keyed by (date, author, id). Emit 'timeline-changed'.

getOwn(date) → Entry[]
  Read from 'timeline-local' for (date, self-author).

getOther(date, otherAuthor) → Promise<Entry[]>
  Online: GET timelines/<otherAuthor>.json, cache in 'timeline-cache'.
  Offline: read 'timeline-cache'. 404 / cache miss → [].

getCombined(date) → Promise<Entry[]>
  Union getOwn + getOther for both other authors, sorted by t.

listAvailableDates() → Promise<string[]>
  listDir('days') filtered to YYYY-MM-DD format. Always include TODAY.

clearLocal() → void
  For reset-app.
```

IDB stores: `timeline-local`, `timeline-cache`. Schema declared in this module.

### `services/thumbs.js`

```
storeLocal(ref, blob) → void
  Save thumbnail blob to 'thumbs-local' IDB store keyed by ref.

getLocalUrl(ref) → string | null
  URL.createObjectURL on the cached blob, or null if not present.

unsyncedRefs(date) → ref[]
  Return refs whose thumb hasn't been pushed to GitHub yet (per sync-state IDB).

markSynced(ref) → void
  Record successful upload.
```

IDB stores: `thumbs-local`, `thumbs-sync-state`. Schema in this module.

### `services/sync.js`

```
syncToday() → { entriesUploaded, thumbsUploaded, errors }
  See section 6.

lastSyncedAt() → ISO string | null
  For UI display.

isAutoSyncDue() → boolean
  Throttle for foreground/online triggers (e.g. min 60s between auto attempts).
```

### `services/queue.js`

Schema responsibility moves here from `db.js`. `enqueue` / `flush` / `count` / `clear` API unchanged. Continues to handle creates-only items (raw captures + thumb uploads).

---

## 10. File-by-file delta

| File | Action |
|---|---|
| `pwa/phone/services/timeline.js` | **NEW** — section 9 |
| `pwa/phone/services/thumbs.js` | **NEW** — section 9 |
| `pwa/phone/services/sync.js` | **NEW** — section 9 |
| `pwa/phone/services/queue.js` | Take over `raw-queue` schema declaration from `db.js` |
| `pwa/phone/tabs/log/log.js` | Drop `vault` + `db.js` imports; rewrite `writeLogLine` (→ `timeline.appendLocal`), `finishPhotoWrite` (→ `timeline.appendLocal` + `thumbs.storeLocal`); drop `syncQueue`, `checkConflicts`, `parseLogMd`, `parseLogLine`, `resolvePhotoName`. Drop `onPhotoSelected` preview wiring per D5. Add `submitPhoto` thumbnail-generation path. |
| `pwa/phone/tabs/log/log-ui.js` | Drop `vault` import; rewrite photo render branch — own photos use `thumbs.getLocalUrl(ref)`, other-author photos render as placeholder. Adjust entry shape (`type: 'note'` not `'text'`, `content` not `text`). |
| `pwa/phone/tabs/log/log.js` (sync UI) | Add "Sync now" button handler, last-synced display |
| `pwa/phone/core/state.js` | Delete `vault: null` field (D7) |
| `pwa/phone/app.js` | Delete: `FSA_SUPPORTED`, `pick-vault-btn` listener, `activateVault`, `showVaultBanner`, `reconnect-btn` listener, `conflict-dismiss` listener, `getVaultHandle`/`saveVaultHandle` import, `vault.js` import, `db.js` import, all `s.vault` branches. Add: foreground/`online` triggers calling `sync.syncToday()`. |
| `pwa/phone/index.html` | Delete `#vault-setup-overlay`, `#vault-banner`, `#conflict-banner` markup; delete `#photo-preview` + `#photo-preview-status` markup and related CSS (D5); add `capture="environment"` to `#photo-input`; add "Sync now" button + last-synced label to log tab |
| `pwa/phone/sw.js` | Bump `CACHE` to `tv-phone-v41`; remove `./db.js` and `./vault.js` from `SHELL`; add `./services/timeline.js`, `./services/thumbs.js`, `./services/sync.js` |
| `pwa/phone/vault.js` | **DELETE** |
| `pwa/phone/db.js` | **DELETE** (D6) |
| `pwa-structure.md` | Append `services/timeline.js`, `services/thumbs.js`, `services/sync.js` blocks. Update phase line to "current phase: 4 done". |
| `pwa/phone/PHASE4.md` | This file — the recovery doc per `coding-general.md` Section 13 |
| `REARCHITECTURE.md` | Mark Phase 4 as `✅ SHIPPED <date>` after deploy. Note that Phase 5 (Worker snapshot) is now optional/deferred and Phase 6 (assembly PWA at home) is the new path to print. |
| `PROGRESS.md` | Append entry after deploy |

---

## 11. Step ordering — one commit per step

| # | Step | Files | Verifiable end-state |
|---|---|---|---|
| 0 | **Plan committed** | `PHASE4.md` only | This file on disk |
| 1 | **`services/timeline.js` + IDB schema move** | `services/timeline.js` (new), `services/queue.js` (schema), `sw.js` (SHELL+cache prep) | `node --check` passes; nothing imports it yet |
| 2 | **`services/thumbs.js`** | `services/thumbs.js` (new), `sw.js` | Standalone module ready |
| 3 | **`services/sync.js`** | `services/sync.js` (new), `sw.js` | Wires timeline + thumbs + queue + github. Standalone. |
| 4 | **Log tab capture path** — `writeLogLine`, `finishPhotoWrite`, photo confirm flow | `tabs/log/log.js`, `tabs/log/log-ui.js`, `index.html` (camera capture, drop preview), `core/state.js` | Tap check-in / note / photo writes to local IDB. Visible in log immediately. Nothing yet on GitHub. |
| 5 | **Log tab read path** — `loadLog` via `timeline.getCombined`, day nav via `timeline.listAvailableDates` | `tabs/log/log.js`, `tabs/log/log-ui.js` | Own entries render. Other-author entries render after a sync from the other device (see step 6). |
| 6 | **Sync UI + triggers** | `tabs/log/log.js`, `index.html` (sync button + label), `app.js` (foreground/online handlers) | "Sync now" PUTs `timelines/<author>.json` and thumbs. Verify in data repo. |
| 7 | **Delete vault overlays + listeners** | `app.js`, `index.html` (overlays markup) | App boots straight to author-pick → main. |
| 8 | **Delete `vault.js` + `db.js`** | Delete files; drop imports from `app.js`, `tabs/log/log.js`, `tabs/log/log-ui.js`; `sw.js` SHELL | `grep -r 'vault\\.js\\|db\\.js'` returns nothing in `pwa/phone/` |
| 9 | **Standards updates** | `pwa-structure.md`, `PHASE4.md` (mark done) | Standards reflect new structure |
| 10 | **Deploy** — VERSION 40 → 41, CACHE v40 → v41, `?v=N` lockstep | `app.js`, `sw.js`, push routine | Phone Chrome shows v41; capture works offline; sync publishes; cross-device read works |
| 11 | **PROGRESS.md entry** | `PROGRESS.md`, `REARCHITECTURE.md` (Phase 4 ✅) | Phase 4 logged |

Each commit is small and revertable. Cutover is in steps 4–6. Cleanup in 7–9. Deploy in 10.

---

## 12. Risks and pre-empts

| Risk | Mitigation |
|---|---|
| **Camera filename ≠ ref filename.** Android assigns its own name; we record `YYYY-MM-DD_HHMMSS_<author>.jpg`. | Spec: assembly PWA matches by EXIF DateTimeOriginal within ±2s window, not by filename. The `ref` is informational. Document in PHASE4.md (done above). |
| **Sync failure mid-flight** (some thumbs uploaded, timeline.json not yet). | Order: thumbs first, timeline.json last. Partial state means orphan thumbs (harmless), retried on next sync. Timeline.json being last ensures it always references thumbs that exist. |
| **Duplicate sync** producing duplicate thumb PUTs. | Queue treats 422 as success (existing contract). `thumbs.markSynced` records local state — duplicate is a no-op. |
| **Cross-device entry id collision** within same second between authors. | `id = HHMMSS_<author>` (D4). |
| **Same-author two-photos-per-second** (e.g. burst). | Append `_<n>` suffix on collision in `timeline-local` write path. Trivial. |
| **IDB eviction under storage pressure** could lose unsynced entries. | `navigator.storage.persist()` is already requested in `init()`. Sync prompt in UI emphasises "you have N unsynced entries" so user is aware. |
| **User forgets to sync.** | Auto-triggers on foreground + online. Last-sync timestamp visible in log tab. Counter of unsynced entries visible. |
| **Time-of-day sync race** — two devices both PUT their own `<author>.json` at the same evening. | Different paths, no conflict. |
| **Edits after sync** producing stale sha. | `putFile` refetches sha on 409/422 and retries once. Works for full-file replace. |
| **Thumbnail generation slow on old phones.** | `<canvas>` resize at 1600px is fast (sub-second on any modern phone). Profile if it's perceptibly slow. |

---

## 13. "Done when" criteria

1. App boots without prompting for a vault folder. No `#vault-setup-overlay` in DOM.
2. Tap check-in → entry appears in log tab immediately. Network not required.
3. Tap photo → camera opens (Android Chrome) → capture → comment form → confirm → entry in log tab with own thumbnail visible.
4. Multiple captures while offline persist across app reload.
5. Tap "Sync now" while online → `days/YYYY-MM-DD/timelines/<author>.json` and `thumbs/<ref>` files appear in `acorell/travel-vault-data` within seconds.
6. On phone B, after phone A syncs, refreshing the log tab shows phone A's entries (with placeholder for photos, GPS + comment visible).
7. `services/vault.js` and `db.js` not in repo.
8. SW cache `tv-phone-v41` is the active version on the phone.
9. STRUCTURE.md Issue 1 closed by removal of preview UI.
10. STRUCTURE.md Issue 2 closed by per-author timelines published to GitHub.

---

## 14. Out of scope for Phase 4

- Cross-device thumbnails during the trip (PWA fetching other-author thumbs from GitHub mid-day). Possible follow-up.
- Editing or deleting entries after sync. Local edits work; remote edit UI deferred.
- The assembly PWA (Phase 6) — home-time curation with full-res photos via FSA on a PC.
- Phase 5 Worker snapshot generation — now optional. The end-to-end path to print is: Phase 4 capture → Phase 6 assembly → print pipeline. Phase 5 is nice-to-have for in-PWA reading of a day's narrative, not required for the book.
- Migration of historical FSA `log.md` (D8 = accept loss).
- Worker changes (none in Phase 4).

---

## 15. Pre-execution checklist

Before kicking off the execution session at `/effort high`:

- [ ] User confirms decisions D1–D8.
- [ ] User confirms step ordering (11 commits) is acceptable.
- [ ] PHASE4.md committed first (step 0).
- [ ] Confirm GitHub PAT still has `Contents: read+write` on `acorell/travel-vault-data`.
- [ ] Confirm no in-flight test data in `days/` that would surprise on first sync.
