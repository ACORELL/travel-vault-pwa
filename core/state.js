// Shared mutable app state and cross-tab date constants.
// Multiple modules import `s` and read/write its fields directly via ES module live bindings.

export const TODAY = new Date().toISOString().slice(0, 10);

export const TOMORROW = (() => {
  const d = new Date(TODAY + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
})();

export const IS_WEEKEND_TODAY = (() => {
  const day = new Date(TODAY + 'T12:00:00').getDay();
  return day === 0 || day === 6;
})();

export const s = {
  author:        localStorage.getItem('tv-author'),
  vault:         null,
  syncStatus:    'offline',
  logEntries:    [],
  wikiPages:     [],
  pendingPhoto:  null,   // { file, ts }
  pendingDraft:  null,   // { type: 'note'|'photo', text?, file?, ts?, comment? }
  viewedDate:    TODAY,
  availableDays: [],
};
