# Phase 3b — `app.js` Structural Extraction Plan

**Current state: Phase 3b CLOSED. Shipped at SW cache `tv-phone-v35`. `app.js` 1607 → 235 lines, 11 modules in place. User smoke-tested core flows on PC and confirmed they still work.**

---

## Open follow-up issues (next session — NOT Phase 3b regressions)

Three things surfaced during the user's smoke test of the deployed v35. None is a Phase 3b regression — they are pre-existing behaviour or full-phase tasks. Each gets its own scoped session, NOT folded into Phase 3b.

### Issue 1 — Photo preview missing on the photo-add flow

**Symptom:** Tap "Add photo" in the log tab → pick a file → no thumbnail appears in the photo-add form. The comment input becomes editable, but the preview area stays blank.

**Where to look:** `pwa/phone/tabs/log/log.js#onPhotoSelected`. The handler sets:
```js
const prev = $('photo-preview');
prev.src = URL.createObjectURL(file);
prev.style.display = 'block';
$('photo-pick-area').style.display = 'none';
```
Then `cancelPhotoForm` later does the inverse. The mismatch is likely one of: (a) `#photo-preview` element ID changed in `index.html`, (b) a CSS rule overrides `display:block`, (c) the file input's `change` event isn't firing on the user's browser. Open Firefox devtools, watch the element's computed style and `src` attribute when `change` fires.

**Scope:** small isolated bug fix. Own session, `/effort high` is fine. Verify on PC Firefox AND on the actual phone Chrome (the only deployment target).

### Issue 2 — Cross-device log invisibility (Phase 4 territory)

**Symptom:** Phone, tablet, and PC each see only the log entries they themselves added. A check-in on the phone is invisible from the PC; a note added on the tablet doesn't appear on the phone. Photos similarly device-local.

**Root cause:** today's log lives in `days/YYYY-MM-DD/log.md` *inside each device's local FSA-mounted vault folder*. The data path is FSA → file → Obsidian Sync → other devices. If Obsidian isn't running and foregrounded, no sync happens. Photos are even more brittle (binary, large, FSA-local).

**This is exactly Phase 4 in `/vault/REARCHITECTURE.md`.** The fix:
- Rewrite log writes through `services/github.js` + `services/queue.js` to commit `days/YYYY-MM-DD/timeline.json` to the private `acorell/travel-vault-data` repo (one append-only JSON file per day, not log.md)
- Photo entries record only a timestamp-based reference (filename only) — binary stays in the camera roll, synced via Google Photos shared album (Phase 5 fetches them)
- Cache the current day's timeline in IndexedDB for offline read
- Delete `services/vault.js` and the FSA-related banners/overlay/listeners in `app.js`
- Delete the `db.js` log-queue path (the GitHub queue replaces it)

**Phase 3b moved the code structurally**; Phase 4 changes the data backend. Different concerns, different sessions. Phase 4 needs its own plan-phase per `coding-general.md` Section 3 (`/effort max` for the plan; `/effort high` for execution).

**Plan-phase reading list for Phase 4:**
- `/vault/REARCHITECTURE.md` (Phase 4 section — timeline.json schema is already specified)
- `/vault/pwa/phone/tabs/log/log.js` (every FSA call needs a github.js equivalent: `appendLogLines` → append entry to timeline.json then PUT; `savePhoto` → drop binary entirely, write photo timeline entry; `readLogMd` → `getFile('days/YYYY-MM-DD/timeline.json')`; `listDayFolders` → `listDir('days')`; `detectConflicts` → retire, GitHub gives last-writer-wins by SHA)
- `/vault/pwa/phone/tabs/log/log-ui.js` (renderLog needs to consume a timeline JSON array instead of parsed log.md entries — entry shape change)
- `/vault/pwa/phone/services/queue.js` (already handles offline → online flush; reuse for log writes)
- `/commons/standards/pwa-structure.md` "Phase Transition Notes" section (the planned deletion list when Phase 4 lands)

### Issue 3 — Author selection only on first launch

**Status: confirmed expected, no action.** `init()` in `app.js` only shows the `setup-overlay` when `localStorage['tv-author']` is missing. Per-browser, per-device. User confirmed this is fine.

---

This document is the contract for Phase 3b: pure structural extraction of
`pwa/phone/app.js` into the layout defined in `pwa-structure.md`. Zero
behaviour changes. No logic changes, no bug fixes, no renames unless a name
conflicts with the new structure. Each extraction gets its own commit.

Source file at start of Phase 3b: `pwa/phone/app.js` — 1607 lines.

---

## 1. Inventory of every logical unit in `app.js`

Grouped by current source location, mapped to the target file from
`pwa-structure.md`. Line numbers match `app.js` HEAD at the start of Phase 3b.

### Top of file: imports + state primitives

| Lines | Unit | Target |
|---|---|---|
| 1–8 | Module imports | (stays) — `app.js` shrinks but remains the entry |
| 11–20 | `TODAY`, `TOMORROW`, `IS_WEEKEND_TODAY` | `core/state.js` (cross-tab date constants) |
| 22 | `CHECKIN_PROXIMITY_THRESHOLD_M` | `tabs/log/log.js` (only used in proximity check) |
| 24–27 | `AUTHOR_COLORS` | `tabs/log/log-ui.js` (only used in `renderLog`) |
| 30–40 | `s` state object | `core/state.js` (shared mutable; live binding via ES module) |

### Bootstrap / app shell

| Lines | Unit | Target |
|---|---|---|
| 43–44 | `VERSION`, `FSA_SUPPORTED` | `app.js` (bootstrap) |
| 47–51 | Version stamp DOM injection | `app.js` (bootstrap) |
| 53–80 | `init()` (author selection + bootApp) | `app.js` |
| 84–89 | `bootApp()` | `app.js` |
| 94–107 | `tryFlush()` | `app.js` (bootstrap glue; called from boot, online event, settings) |
| 110 | `try-flush` window listener | `app.js` |
| 112–120 | `resetApp()` | `app.js` |
| 124–140 | `pick-vault-btn` click listener | `app.js` (FSA — Phase 4 deletes) |
| 145–159 | `activateVault()` | `app.js` (FSA — Phase 4 deletes) |
| 161–194 | `startApp()` (main wiring call) | `app.js` |
| 197 | `sync-status` window listener | `app.js` |
| 201–208 | `online`/`offline` listeners | `app.js` |
| 210–224 | `showVaultBanner()` | `app.js` (FSA — Phase 4 deletes) |
| 226–236 | `reconnect-btn` listener | `app.js` (FSA — Phase 4 deletes) |
| 238 | `conflict-dismiss` listener | `app.js` (FSA — Phase 4 deletes) |
| 1520–1521 | reset-btn-1, reset-btn-2 listeners | `app.js` |
| 1607 | `init()` invocation | `app.js` |

### Sync queue (FSA-flavored — distinct from `services/queue.js`)

| Lines | Unit | Target |
|---|---|---|
| 241–266 | `syncQueue()` (drains `db.js` log queue → FSA) | `tabs/log/log.js` (FSA-specific; Phase 4 deletes) |

### Log tab — handlers

| Lines | Unit | Target |
|---|---|---|
| 269–299 | `setupLogTab()` | `tabs/log/log.js` |
| 301–333 | `checkIn()` | `tabs/log/log.js` |
| 335–341 | `openNoteForm()` | `tabs/log/log.js` |
| 343–370 | `submitNote()` | `tabs/log/log.js` |
| 372–388 | `onPhotoSelected()` | `tabs/log/log.js` |
| 390–400 | `cancelPhotoForm()` | `tabs/log/log.js` |
| 402–434 | `submitPhoto()` | `tabs/log/log.js` |
| 436–456 | `finishPhotoWrite()` | `tabs/log/log.js` |
| 458–463 | `resolvePhotoName()` | `tabs/log/log.js` |
| 465–471 | `writeLogLine()` | `tabs/log/log.js` |
| 473–494 | `loadLog()` | `tabs/log/log.js` |
| 496–502 | `parseLogMd()` | `tabs/log/log.js` |
| 504–520 | `parseLogLine()` | `tabs/log/log.js` |
| 1316–1324 | `checkConflicts()` | `tabs/log/log.js` |
| 1372–1378 | `autoSubmitDraft()` | `tabs/log/log.js` |

### Log tab — render + day nav

| Lines | Unit | Target |
|---|---|---|
| 522–573 | `renderLog()` | `tabs/log/log-ui.js` |
| 577–585 | `loadAvailableDays()` | `tabs/log/log.js` |
| 587–595 | `navigateDay()` | `tabs/log/log.js` |
| 597–602 | `updateDayNavUI()` | `tabs/log/log-ui.js` |
| 604–627 | `updateActionBarState()` | `tabs/log/log-ui.js` |
| 1380–1385 | `showPendingDraft()` | `tabs/log/log-ui.js` |
| 1387–1392 | `hidePendingDraft()` | `tabs/log/log-ui.js` |
| 1487–1508 | `checkinMapHtml()` (OSM tile pin) | `tabs/log/log-ui.js` |

### Proximity (log tab)

| Lines | Unit | Target |
|---|---|---|
| 1331–1339 | `haversineMetres()` | `tabs/log/log.js` |
| 1341–1347 | `getLastCheckinGps()` | `tabs/log/log.js` |
| 1349–1358 | `sampleGpsForProximity()` | `tabs/log/log.js` (or routed through `services/location.js` per Decision A) |
| 1361–1368 | `checkProximity()` | `tabs/log/log.js` |

### Wiki tab — list + article

| Lines | Unit | Target |
|---|---|---|
| 630–645 | `setupWikiTab()` | split: wiki listeners → `tabs/wiki/wiki-ui.js`; capture listeners → `tabs/capture/capture-ui.js` (`initCaptureUi`) |
| 647–654 | `loadWiki()` | `tabs/wiki/wiki.js` |
| 1135 | `TYPE_LABEL` | `tabs/wiki/wiki-ui.js` |
| 1136 | `TYPE_ORDER` | `tabs/wiki/wiki-ui.js` |
| 1138–1199 | `renderWikiList()` | `tabs/wiki/wiki-ui.js` |
| 1201–1224 | `openArticle()` | `tabs/wiki/wiki-ui.js` |
| 1226–1297 | `buildHotelCard()` | `tabs/wiki/wiki-ui.js` |

### Wiki tab — today/tomorrow strip

| Lines | Unit | Target |
|---|---|---|
| 656 | `TRANSPORT_EMOJI` | `tabs/wiki/today-strip.js` |
| 659–666 | `stayDayOf`, `stayNights` | `tabs/wiki/today-strip.js` |
| 669–689 | `parseDurationToMins`, `activityEndMins`, `activityEndTimeStr` | `tabs/wiki/today-strip.js` |
| 693–739 | `itemState()` | `tabs/wiki/today-strip.js` |
| 742–762 | `extractFlightNum`, `extractIATA`, `extractTerminal`, `extractAirportName`, `extractPassengers` | `tabs/wiki/today-strip.js` |
| 764–799 | `formatTodayLine()` | `tabs/wiki/today-strip.js` |
| 801–823 | `formatTomorrowLine()` | `tabs/wiki/today-strip.js` |
| 826–834 | `pairRow`, `lv` | `tabs/wiki/today-strip.js` |
| 836–987 | `buildFoldHtml()` | `tabs/wiki/today-strip.js` |
| 989–991 | `STRIP_CATEGORY_ORDER`, `STRIP_CATEGORY_LABEL`, `STRIP_CATEGORY_CLASS` | `tabs/wiki/today-strip.js` |
| 993–998 | `primaryTime()` | `tabs/wiki/today-strip.js` |
| 1000–1007 | `tomorrowPrimaryTime()` | `tabs/wiki/today-strip.js` |
| 1009 | `isPast()` | `tabs/wiki/today-strip.js` — **flag: appears unused, kept for Phase 3b** |
| 1011–1021 | `formatCountdown()` | `tabs/wiki/today-strip.js` |
| 1023–1109 | `renderTodayStrip()` | `tabs/wiki/today-strip.js` |
| 1111–1133 | `loadTodaySourceFile()` | `tabs/wiki/today-strip.js` |
| 1524–1602 | `renderTestStrip()` (dev-only) | `tabs/wiki/today-strip.js` |
| 1603 | `window.renderTestStrip = …` | `tabs/wiki/today-strip.js` |
| 1605 | `setInterval(renderTodayStrip, 60000)` | `app.js` (bootstrap side-effect) — Decision E |

### Capture (raw capture sheet — currently triggered from Wiki tab)

| Lines | Unit | Target |
|---|---|---|
| 1396–1403 | `openCaptureSheet()` | `tabs/capture/capture-ui.js` |
| 1405–1409 | `closeCaptureSheet()` | `tabs/capture/capture-ui.js` |
| 1411–1484 | `saveRawCapture()` | `tabs/capture/capture-ui.js` (logic+UI bundled per Decision C) |

### Tab routing

| Lines | Unit | Target |
|---|---|---|
| 1300–1306 | `setupTabs()` | `core/router.js` |

### Sync status / banners

| Lines | Unit | Target |
|---|---|---|
| 1309–1314 | `setSyncStatus()` | `core/ui.js` (state write + dot DOM update; small enough to bundle) |
| 1326 | `showBanner()` | `core/ui.js` |
| 1327 | `hideBanner()` | `core/ui.js` |

### Pure helpers

| Lines | Unit | Target |
|---|---|---|
| 1510 | `nowHHMM()` | `core/ui.js` |
| 1511 | `nowHHMMSS()` | `core/ui.js` |
| 1512 | `pad()` | `core/ui.js` |
| 1513 | `esc()` | `core/ui.js` |
| 1514 | `fmtDate()` | `core/ui.js` |
| 1515–1518 | `$, $$, show, hide` | `core/ui.js` |

---

## 2. Dependencies that affect extraction order

The extraction is a textual move + import rewire — no logic changes. Order
matters only because each step must leave `app.js` in a working state.

**Hard ordering constraint: foundations before consumers.**

```
core/ui.js  (DOM helpers, formatters, setSyncStatus, banners)
   ↑
core/state.js  (s, TODAY, TOMORROW, IS_WEEKEND_TODAY)
   ↑
   ├── tabs/wiki/wiki-ui.js + today-strip.js + wiki.js
   ├── tabs/log/log.js + log-ui.js
   └── tabs/capture/capture-ui.js
   ↑
core/router.js  (setupTabs)
```

- Every tab module reads `s` and uses `$, esc, fmtDate, setSyncStatus`. Those
  must exist before any tab is extracted.
- `TODAY` is used by log (`loadAvailableDays`, `updateActionBarState`), wiki
  (`matchesDate`), capture (path build), and the test fixture. State.js must
  be extracted before any tab.
- `setSyncStatus` is called from log (`syncQueue`, `writeLogLine`), capture
  (`saveRawCapture`), and bootstrap. Putting it in `core/ui.js` avoids a
  circular `tab → app.js` import.
- `tabs/wiki/wiki-ui.js`'s current `setupWikiTab` wires the **capture**
  listeners (`wiki-capture-btn`, `capture-cancel`, `capture-save`). When
  capture is extracted, those three lines move to
  `tabs/capture/capture-ui.js#initCaptureUi`. Wiki-ui temporarily holds the
  listeners until the capture step.
- `tabs/wiki/wiki.js` (`loadWiki`) depends on `renderTodayStrip` and
  `renderWikiList`. Extract it after both UI files exist.

**No ordering constraint between log and wiki tabs** — they don't import each
other.

---

## 3. Decisions — confirmed answers

### Decision A — `services/location.js` extraction

**Confirmed: B1 — parameterized.**

Extract `services/location.js` exporting `sample({ timeout, maximumAge })`.
The three callers (`checkIn`, `sampleGpsForProximity`, `saveRawCapture`) pass
their existing options:

| Call site | timeout | maximumAge |
|---|---|---|
| `checkIn()` (line 311) | 10000 | 0 |
| `sampleGpsForProximity()` (line 1352) | 5000 | 60000 |
| `saveRawCapture()` (line 1422) | 5000 | 60000 |

Behaviour-identical, structurally clean. The doc's "5s/60s" defaults are
aspirational — convergence on canonical timeouts is a follow-up decision,
not part of Phase 3b.

### Decision B — `setSyncStatus` placement

**Confirmed: C1 — `core/ui.js`.**

`setSyncStatus` writes `s.syncStatus` and updates `#sync-dot`. Lives in
`core/ui.js`, imports `s` from `core/state.js`. Avoids a circular
`tab → app.js` import. Splitting state-write from DOM-update via an event
emitter is a refactor; deferred.

### Decision C — capture file split

**Confirmed: D1 — single file `tabs/capture/capture-ui.js`.**

`openCaptureSheet`, `closeCaptureSheet`, `saveRawCapture`, and a new
`initCaptureUi()` (which wires the three capture listeners previously in
`setupWikiTab`) live in one file. Splitting `saveRawCapture` into pure logic +
UI callbacks is a refactor; deferred.

### Decision D — `today-strip.js` size

**Confirmed: E1 — one file ~500 lines.**

Phase 3b moves code; it does not subdivide responsibilities. The strip is a
single coherent responsibility. Further splitting (e.g. `today-strip-cards.js`
for `buildFoldHtml`, `strip-utils.js` for the parsers) is a follow-up.

### Decision E — `setInterval(renderTodayStrip, 60000)`

**Confirmed: F1 — stays in `app.js`.**

All bootstrap-level side effects remain visible in one file. `app.js` imports
`renderTodayStrip` and ticks it.

### Decision G — log tab extraction in Phase 3b

**Confirmed: G1 — extract now.**

`tabs/log/log.js` and `tabs/log/log-ui.js` are created in Phase 3b even
though Phase 4 will rewrite the log to use `github.js + queue.js` and delete
`services/vault.js`. Structural extraction is independent of the I/O backend.

### Decision I — `index.html` entry point

**Confirmed: J1 — keep `app.js` as the entry.**

`<script type="module" src="./app.js">` does not change. `core/router.js` is
just `setupTabs`. No HTML/SW-cache churn beyond what the `.js` extractions
already cause.

### Photos handling (sub-decision under G)

Photo handlers stay in `tabs/log/log.js` for Phase 3b — they're triggered by
log-tab UI. Phase 4 splits them into `tabs/photos/` when `timeline.json`
lands.

### Likely-dead code

`extractAirportName` (line 754), `extractPassengers` (line 757), `isPast`
(line 1009) appear unused. **Phase 3b moves them as-is into
`today-strip.js`.** Cleanup is a separate pass.

---

## 4. Extraction order — one commit per step

Each step preserves identical behaviour. Verify on PC Firefox after every
step before moving on (capture path, log render, wiki list, today strip with
`?dev=1`, sync dot transitions on toggling network). All must look and behave
identically.

| # | Step | New / changed files | Rough size | Risk |
|---|---|---|---|---|
| 1 | **`core/ui.js`** — `$, $$, show, hide, pad, esc, fmtDate, nowHHMM, nowHHMMSS, showBanner, hideBanner`. `app.js` imports them. `setSyncStatus` deferred to Step 2 because it reads `s`. | new file ~45 lines | very low — pure leaf utilities |
| 2 | **`core/state.js`** + `setSyncStatus` to `core/ui.js`. `core/state.js` exports `s`, `TODAY`, `TOMORROW`, `IS_WEEKEND_TODAY`. `setSyncStatus` moves into `core/ui.js` now that it can cleanly import `s`. | new file ~25 lines + ui.js +6 lines | low — small, isolated |
| 3 | **`services/location.js`** — `sample({ timeout, maximumAge })`. Three call sites updated to pass their existing options. | new file ~15 lines | low — parameterized, behaviour-identical |
| 4 | **`tabs/wiki/wiki-ui.js`** — `setupWikiTab` (wiki-only listeners), `renderWikiList`, `openArticle`, `buildHotelCard`, `TYPE_LABEL`, `TYPE_ORDER`. Capture listeners stay temporarily in `setupWikiTab` and move in step 6. | new file ~170 lines | medium — touches the wiki tab user flow |
| 5 | **`tabs/wiki/today-strip.js`** — all strip code + helpers + dev test fixture. | new file ~500 lines | medium — biggest single move; one big sweep through 460 contiguous lines of `app.js` |
| 6 | **`tabs/capture/capture-ui.js`** — `openCaptureSheet`, `closeCaptureSheet`, `saveRawCapture`, `initCaptureUi()` wires the three capture listeners that previously lived in `setupWikiTab`. `wiki-ui.js` drops those three lines. `app.js` calls `captureUi.init()` from `startApp`. | new file ~100 lines, `wiki-ui.js` -3 lines | medium — listener ownership moves |
| 7 | **`tabs/wiki/wiki.js`** — `loadWiki()`. Imports `renderTodayStrip` and `renderWikiList`. | new file ~15 lines | very low |
| 8 | **`tabs/log/log-ui.js`** — `renderLog`, `AUTHOR_COLORS`, `checkinMapHtml`, `updateDayNavUI`, `updateActionBarState`, `showPendingDraft`, `hidePendingDraft`. | new file ~140 lines | low — pure render |
| 9 | **`tabs/log/log.js`** — `setupLogTab`, `checkIn`, `openNoteForm`, `submitNote`, photo handlers, `writeLogLine`, `loadLog`, `parseLogMd`, `parseLogLine`, `loadAvailableDays`, `navigateDay`, `autoSubmitDraft`, `syncQueue`, `checkConflicts`, proximity helpers, `CHECKIN_PROXIMITY_THRESHOLD_M`. | new file ~280 lines | medium — broad surface, but every handler is self-contained |
| 10 | **`core/router.js`** — `setupTabs`. `app.js` imports it. | new file ~10 lines | very low |
| 11 | *(Cleanup)* Verify `app.js` is now bootstrap only: imports, `VERSION`, `FSA_SUPPORTED`, version stamp, `init`, `bootApp`, `tryFlush`, `resetApp`, vault setup listeners, `startApp`, sync-status / try-flush / online / offline listeners, banner orchestration calls, reset listeners, `setInterval`, final `init()`. ~150–180 lines. | `app.js` (read-only verification) | none |

**Rollback**: each step is a single commit; `git revert` or
`git reset --hard HEAD~1` if a regression appears.

**SW cache discipline**: the `CACHE` version in `sw.js` and the
`navigator.serviceWorker.register('./sw.js?v=N')` in `app.js` bump together
on every push that ships extraction commits to GitHub Pages.

---

## Phase 3b progress

- **Step 0** — plan confirmed, extraction not yet started ✅
- **Step 1** — `core/ui.js` ✅
- **Step 2** — `core/state.js` + `setSyncStatus` migration ✅
- **Step 3** — `services/location.js` ✅ (+ Step 3 fix: `geoloc` rename)
- **Step 4** — `tabs/wiki/wiki-ui.js` ✅ (capture listeners + dev test button parked in `wireWikiTabExternals` for Steps 5–6)
- **Step 5** — `tabs/wiki/today-strip.js` ✅ (dev test button now uses `todayStrip.renderTestStrip`; capture listeners still in `wireWikiTabExternals` for Step 6)
- **Step 6** — `tabs/capture/capture-ui.js` ✅ (capture listeners moved into `initCaptureUi`; dev test-button hook reduced to `maybeAddTestStripButton`; `putFile`/`GitHubAuthError` import dropped from `app.js` as dead)
- **Step 7** — `tabs/wiki/wiki.js` ✅ (`services/wiki.js` import in `app.js` replaced by `{ loadWiki } from './tabs/wiki/wiki.js'`)
- **Step 8** — `tabs/log/log-ui.js` ✅ (`renderLog`, `AUTHOR_COLORS`, day-nav UI, pending-draft helpers, `checkinMapHtml`; callers in `app.js` re-pointed via `logUi.*`)
- **Step 9** — `tabs/log/log.js` ✅ (handlers + FSA queue drain + log parsing + day-nav + proximity, `CHECKIN_PROXIMITY_THRESHOLD_M` moved; dead `enqueueLogEntry`/`getLogQueue`/`clearLogKeys` imports trimmed from `app.js`)
- **Step 10** — `core/router.js` ✅ (`setupTabs`); dead `core/ui.js` imports (`pad`, `esc`, `nowHHMM`, `nowHHMMSS`, `showBanner`) trimmed from `app.js`
- **Step 11** — `app.js` cleanup verification ✅ (restored `$$` import after author-btn regression; trimmed unused `TOMORROW`, `IS_WEEKEND_TODAY`, `logUi` from `app.js`)

---

## Final layout

```
pwa/phone/
├── app.js                      Bootstrap only — init, vault setup, sync wiring, banners, reset (235 lines)
├── core/
│   ├── ui.js                   $/$$/show/hide, formatters, setSyncStatus, banner toggles
│   ├── state.js                s + date constants
│   └── router.js               setupTabs
├── services/
│   ├── github.js               (existing) GitHub Contents API
│   ├── queue.js                (existing) IndexedDB offline queue
│   ├── settings.js             (existing) localStorage source-of-truth
│   ├── wiki.js                 (existing) loadWikiPages
│   ├── location.js             NEW — parameterized GPS sample
│   └── (vault.js etc. unchanged — still used by log tab; Phase 4 retires)
├── settings/
│   └── settings-ui.js          (existing)
└── tabs/
    ├── capture/capture-ui.js   raw capture sheet + initCaptureUi
    ├── wiki/
    │   ├── wiki.js             loadWiki (data loader)
    │   ├── wiki-ui.js          list + article + hotel card
    │   └── today-strip.js      today/tomorrow strip + helpers + dev test fixture
    └── log/
        ├── log.js              setup + handlers + queue + parsing + day-nav + proximity
        └── log-ui.js           render + day-nav UI + pending-draft + check-in map

Imports remaining in app.js: db.js (vault handle), vault.js (FSA setup), settings/settings-ui.js, tabs/wiki/wiki.js (loadWiki), services/{queue,settings,location}.js, core/{ui,state,router}.js, tabs/{wiki/wiki-ui,wiki/today-strip,capture/capture-ui,log/log}.js.
```

## Commit history

```
c14b7b3  Phase 3b Step 10: extract core/router.js (setupTabs); trim dead helper imports from app.js
071baff  Phase 3b Step 9: extract tabs/log/log.js (handlers + queue + parsing + day-nav + proximity)
4239a5d  Phase 3b Step 8: extract tabs/log/log-ui.js (render + day-nav + draft helpers)
d58a008  Phase 3b Step 7: extract tabs/wiki/wiki.js (loadWiki data loader)
5cdaace  Phase 3b Step 6: extract tabs/capture/capture-ui.js (raw capture sheet)
9c429f6  Phase 3b Step 5: extract tabs/wiki/today-strip.js (strip render + helpers + test fixture)
5dbceeb  Phase 3b Step 4: extract tabs/wiki/wiki-ui.js (list + article + hotel card)
31dac79  Phase 3b Step 3 fix: rename location import to geoloc to avoid window.location shadowing
355101a  Phase 3b Step 3: extract services/location.js (parameterized GPS sample)
7015e78  Phase 3b Step 2: extract core/state.js, migrate setSyncStatus to core/ui.js
f9ef7ae  Phase 3b Step 1: extract core/ui.js (DOM + formatter helpers)
bf9b7b4  Add Phase 3b structural extraction plan
```

Step 11 commit will follow this.

## Verification

`node --check` passes for `app.js`, `core/{ui,state,router}.js`, `services/location.js`, and all four `tabs/*` files.

End-to-end browser verification (still required before deploy):
1. Load `pwa/phone/index.html` on PC Firefox or push to GH Pages with `CACHE` and `?v=` bumped to v35
2. Capture path: text → wiki/raw via PUT (auth-error redirect, offline queue with auto-drain)
3. Log: check-in, note, photo (FSA fallback)
4. Wiki: list accordions, article view, hotel card
5. Today strip: real data + `?dev=1` test fixture (3 cards)
6. Sync dot transitions on toggling network
7. Settings open/save/test connection still triggers queue drain

The PWA is currently at SW cache `tv-phone-v34`. Deploy bumps to v35 (per CLAUDE.md PWA Deployment rules — bump CACHE in sw.js AND `?v=` in app.js's SW registration in lockstep).
