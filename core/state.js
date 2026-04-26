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
  syncStatus:    'offline',
  logEntries:    [],
  wikiPages:     [],
  // What the open form is for. null when no form is open.
  // Shape: { kind: 'add-note' | 'add-photo'
  //              | 'edit-note' | 'edit-photo'                  // Step 8
  //              | 'append-note' | 'append-photo'              // Step 9
  //              | 'edit-appendment-note' | 'edit-appendment-photo'   // Step 8
  //              ...args }   args depend on kind (entryId, parentId, appId, file, t, gps)
  composing:     null,
  // Entry id when the detail-view sheet is open. Independent of `composing`
  // so a form opened from the detail view can re-render the sheet on close.
  // Wired in Step 7.
  viewingEntry:  null,
  viewedDate:    TODAY,
  availableDays: [],
};
