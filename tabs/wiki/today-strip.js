// Today/tomorrow strip rendering, fold-out cards, and dev test fixture.
// Single coherent responsibility: turn s.wikiPages into the strip HTML.
import { $, $$, esc } from '../../core/ui.js';
import { s, TODAY, TOMORROW, IS_WEEKEND_TODAY } from '../../core/state.js';
import * as vault from '../../vault.js';

const TRANSPORT_EMOJI = { flight: '✈️', train: '🚆', bus: '🚌', ferry: '⛴️', other: '🎫' };

// ---- Stay helpers ----
function stayDayOf(checkInDate, today) {
  const ms = new Date(today + 'T12:00:00') - new Date(checkInDate + 'T12:00:00');
  return Math.floor(ms / 86400000) + 1;
}
function stayNights(checkInDate, checkOutDate) {
  const ms = new Date(checkOutDate + 'T12:00:00') - new Date(checkInDate + 'T12:00:00');
  return Math.floor(ms / 86400000);
}

// ---- Duration helpers ----
function parseDurationToMins(dur) {
  if (!dur) return null;
  const parts = String(dur).split(':').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [dd, hh, mm] = parts;
  return dd * 24 * 60 + hh * 60 + mm;
}
function activityEndMins(p) {
  if (!p.reservation_time || !p.duration) return null;
  const [h, m] = p.reservation_time.split(':').map(Number);
  const dur = parseDurationToMins(p.duration);
  if (dur == null) return null;
  return h * 60 + m + dur;
}
function activityEndTimeStr(p) {
  const end = activityEndMins(p);
  if (end == null) return null;
  const h = Math.floor(end / 60) % 24;
  const m = end % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---- Item state ----
// Returns 'upcoming' | 'active' | 'spent' for the current moment
function itemState(p) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();

  if (p.type === 'transport') {
    const t = p.departure_time;
    if (!t) return 'upcoming';
    const [h, m] = t.split(':').map(Number);
    return nowMins >= h * 60 + m ? 'spent' : 'upcoming';
  }

  if (p.type === 'activity') {
    const t = p.reservation_time;
    if (!t) return 'upcoming';
    const [h, m] = t.split(':').map(Number);
    const startMins = h * 60 + m;
    if (nowMins < startMins) return 'upcoming';
    const endMins = activityEndMins(p);
    if (endMins != null && nowMins < endMins) return 'active';
    return 'spent';
  }

  if (p.type === 'hotel') {
    const isCheckInDay  = p.check_in_date  === TODAY;
    const isCheckOutDay = p.check_out_date === TODAY;

    if (isCheckInDay) {
      const ciTime = (IS_WEEKEND_TODAY && p.check_in_time_weekend) ? p.check_in_time_weekend : p.check_in_time;
      if (ciTime) {
        const [h, m] = ciTime.split(':').map(Number);
        if (nowMins < h * 60 + m) return 'upcoming';
      }
    }

    if (isCheckOutDay) {
      const coTime = (IS_WEEKEND_TODAY && p.check_out_time_weekend) ? p.check_out_time_weekend : p.check_out_time;
      if (coTime) {
        const [h, m] = coTime.split(':').map(Number);
        if (nowMins >= h * 60 + m) return 'spent';
      }
    }

    return 'active';
  }

  return 'upcoming';
}

// ---- Flight detail helpers ----
function extractFlightNum(name) {
  const m = name.match(/\bFlight\s+([A-Z]{2,3}\s*\d+)/i) || name.match(/\b([A-Z]{2,3}\s*\d{2,4})\b/);
  return m ? m[1].trim() : name;
}
function extractIATA(point) {
  const m = (point || '').match(/\(([A-Z]{3})\)/);
  return m ? m[1] : null;
}
function extractTerminal(point) {
  const m = (point || '').match(/Terminal\s+(\S+)/i);
  return m ? m[1] : null;
}
function extractAirportName(point) {
  return (point || '').replace(/\s*\([A-Z]{3}\)/, '').split(',')[0].trim();
}
function extractPassengers(items) {
  return (items || []).map(item => {
    const m = item.match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : null;
  }).filter(Boolean);
}

function formatTodayLine(p) {
  if (p.type === 'hotel') {
    const state = itemState(p);
    if (state === 'upcoming') {
      const ciTime = (IS_WEEKEND_TODAY && p.check_in_time_weekend) ? p.check_in_time_weekend : (p.check_in_time || '—');
      return `🏨 ${esc(p.name)} · Check-in ${esc(ciTime)}`;
    }
    if (state === 'active' && p.check_out_date === TODAY) {
      const coTime = (IS_WEEKEND_TODAY && p.check_out_time_weekend) ? p.check_out_time_weekend : (p.check_out_time || '—');
      return `🏨 ${esc(p.name)} · Check-out ${esc(coTime)}`;
    }
    const x = stayDayOf(p.check_in_date, TODAY);
    const y = stayNights(p.check_in_date, p.check_out_date);
    return `🏨 ${esc(p.name)} · Day ${x} of ${y}`;
  }
  if (p.type === 'transport' && p.subtype === 'flight') {
    const flightNum = extractFlightNum(p.name);
    const origin = extractIATA(p.departure_point) || esc(p.departure_point || '—');
    const dest   = extractIATA(p.arrival_point)   || esc(p.arrival_point   || '—');
    return `✈️ ${esc(flightNum)} · ${esc(p.departure_time || '—')} · ${origin} → ${dest}`;
  }
  if (p.type === 'transport') {
    const emoji = TRANSPORT_EMOJI[p.subtype] || '🎫';
    return `${emoji} ${esc(p.name)} · ${esc(p.departure_point || '—')} ${esc(p.departure_time || '—')} · ${esc(p.arrival_point || '—')} ${esc(p.arrival_time || '—')}`;
  }
  if (p.type === 'activity') {
    if (itemState(p) === 'active') {
      const endStr = activityEndTimeStr(p);
      return endStr ? `🎟️ ${esc(p.name)} · Ending at ${endStr}` : `🎟️ ${esc(p.name)}`;
    }
    const parts = [`🎟️ ${esc(p.name)}`];
    if (p.reservation_time) parts.push(esc(p.reservation_time));
    return parts.join(' · ');
  }
  return esc(p.name);
}

function formatTomorrowLine(p) {
  if (p.type === 'transport' && p.subtype === 'flight') {
    return `✈️ ${esc(extractFlightNum(p.name))} · ${esc(p.departure_time || '—')}`;
  }
  if (p.type === 'transport') {
    const emoji = TRANSPORT_EMOJI[p.subtype] || '🎫';
    return `${emoji} ${esc(p.name)} · ${esc(p.departure_time || '—')}`;
  }
  if (p.type === 'hotel') {
    if (p.check_in_date === TOMORROW && p.check_in_time)
      return `🏨 ${esc(p.name)} · ${esc(p.check_in_time)}`;
    if (p.check_out_date === TOMORROW && p.check_out_time)
      return `🏨 ${esc(p.name)} · Check-out ${esc(p.check_out_time)}`;
    return `🏨 ${esc(p.name)}`;
  }
  if (p.type === 'activity') {
    const parts = [`🎟️ ${esc(p.name)}`, esc(p.reservation_time || '—')];
    const endStr = activityEndTimeStr(p);
    if (endStr) parts.push(`Ending at ${endStr}`);
    return parts.join(' · ');
  }
  return esc(p.name);
}

// ---- Fold-out helpers ----
function pairRow(col1Html, col2Html) {
  return `<div class="today-fold-row"><div class="strip-row">` +
    `<div class="strip-col">${col1Html}</div>` +
    `<div class="strip-col">${col2Html}</div>` +
    `</div></div>`;
}
function lv(label, value) {
  return `<span class="strip-label">${esc(label)}</span><span class="strip-value">${value}</span>`;
}

function buildFoldHtml(p, idx) {
  const rows = [];

  if (p.type === 'transport' && p.subtype === 'flight') {
    const terminal    = extractTerminal(p.departure_point);
    const terminalStr = terminal ? `Terminal ${esc(terminal)}` : 'Terminal: Not known';
    const airlineStr  = esc(p.airline || '—');
    const hasSrc      = p.sources && p.sources.length;

    // Row 1: Departs + Ref
    if (p.booking_reference) {
      rows.push(pairRow(lv('Departs', esc(p.departure_time || '—')), lv('Ref', esc(p.booking_reference))));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Departs', esc(p.departure_time || '—'))}</div>`);
    }

    // Row 2: Airline + Terminal
    rows.push(pairRow(lv('Airline', airlineStr), `<span class="strip-value">${terminalStr}</span>`));

    // Row 3: Airport name omitted — maps link below already shows it (Fix 3)

    // Row 3: Departure airport geo link
    if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">${esc(p.departure_point || 'Departure airport')}</a></div>`);
    }

    // Row 4: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    }

  } else if (p.type === 'hotel') {
    const ciTime = (IS_WEEKEND_TODAY && p.check_in_time_weekend)  ? p.check_in_time_weekend  : (p.check_in_time  || '—');
    const coTime = (IS_WEEKEND_TODAY && p.check_out_time_weekend) ? p.check_out_time_weekend : (p.check_out_time || '—');
    const hasSrc = p.sources && p.sources.length;
    const hasWeb = p.website_url;

    // Row 1: Check-in + Ref
    if (p.booking_reference) {
      rows.push(pairRow(lv('Check-in', esc(ciTime)), lv('Ref', esc(p.booking_reference))));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Check-in', esc(ciTime))}</div>`);
    }

    // Row 2: Check-out + Day X of Y
    if (p.check_in_date && p.check_out_date) {
      const x = stayDayOf(p.check_in_date, TODAY);
      const y = stayNights(p.check_in_date, p.check_out_date);
      rows.push(pairRow(lv('Check-out', esc(coTime)), `<span class="strip-value">Day ${x} of ${y}</span>`));
    } else {
      rows.push(`<div class="today-fold-row">${lv('Check-out', esc(coTime))}</div>`);
    }

    // Row 3: Address geo link
    if (p.address) {
      const geoUri = (p.lat != null && p.lon != null)
        ? `geo:${p.lat},${p.lon}?q=${encodeURIComponent(p.address)}`
        : null;
      rows.push(geoUri
        ? `<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">${esc(p.address)}</a></div>`
        : `<div class="today-fold-row">${esc(p.address)}</div>`);
    } else if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }

    // Row 4: Phone
    if (p.phone) {
      const telHref = `tel:${p.phone.replace(/[\s-]/g, '')}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(telHref)}">${esc(p.phone)}</a></div>`);
    }

    // Row 5: Hotel website
    if (hasWeb) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.website_url)}" target="_blank" rel="noopener">Hotel website →</a></div>`);
    }

    // Row 6: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    }

  } else if (p.type === 'activity') {
    const hasSrc = p.sources && p.sources.length;
    const hasDet = p.details_url;

    // Row 1: Start time + Ref
    if (p.reservation_time && p.booking_reference) {
      rows.push(pairRow(lv('Start', esc(p.reservation_time)), lv('Ref', esc(p.booking_reference))));
    } else if (p.reservation_time) {
      rows.push(`<div class="today-fold-row">${lv('Start', esc(p.reservation_time))}</div>`);
    } else if (p.booking_reference) {
      rows.push(`<div class="today-fold-row">${lv('Ref', esc(p.booking_reference))}</div>`);
    }

    // Row 2: Address maps link
    if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }

    // Row 3: View doc
    if (hasSrc) {
      const src = p.sources[0];
      rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
        `<span class="today-source-label strip-value">View doc →</span>` +
        `<div class="today-source-content" style="display:none"></div>` +
        `</div>`);
    } else if (hasDet) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.details_url)}" target="_blank" rel="noopener">Details →</a></div>`);
    }

  } else {
    // Non-flight transport and other types
    if (p.booking_reference) {
      rows.push(`<div class="today-fold-row"><span class="fold-label">Booking ref</span> ${esc(p.booking_reference)}</div>`);
    }
    if (p.maps_url) {
      rows.push(`<div class="today-fold-row"><a href="${esc(p.maps_url)}" target="_blank" rel="noopener">Open in Maps →</a></div>`);
    } else if (p.lat != null && p.lon != null) {
      const geoUri = `geo:${p.lat},${p.lon}?q=${p.lat},${p.lon}`;
      rows.push(`<div class="today-fold-row"><a href="${esc(geoUri)}" rel="noopener">Open in Maps →</a></div>`);
    }
    if (p.special_notes) {
      rows.push(`<div class="today-fold-row"><span class="fold-label">📝 Notes</span> ${esc(p.special_notes)}</div>`);
    }
    if (p.reservation_items && p.reservation_items.length) {
      const items = p.reservation_items.map(item => `<li>${esc(item)}</li>`).join('');
      rows.push(`<div class="today-fold-row"><span class="fold-label">Confirmed</span><ol class="today-fold-list">${items}</ol></div>`);
    }
    if (p.sources && p.sources.length) {
      p.sources.forEach(src => {
        const filename = src.split('/').pop();
        rows.push(`<div class="today-fold-row today-source-row" data-source="${esc(src)}">` +
          `<span class="today-source-label">${esc(filename)}</span>` +
          `<div class="today-source-content" style="display:none"></div>` +
          `</div>`);
      });
    }
  }

  return rows.join('');
}

const STRIP_CATEGORY_ORDER = ['transport', 'hotel', 'activity'];
const STRIP_CATEGORY_LABEL = { transport: 'Flights', hotel: 'Hotels', activity: 'Activities' };
const STRIP_CATEGORY_CLASS = { hotel: 'today-item-hotel', transport: 'today-item-transport', activity: 'today-item-activity' };

function primaryTime(p) {
  if (p.type === 'hotel')     return p.check_in_time    || '00:00';
  if (p.type === 'transport') return p.departure_time   || '00:00';
  if (p.type === 'activity')  return p.reservation_time || '00:00';
  return '00:00';
}

function tomorrowPrimaryTime(p) {
  if (p.type === 'hotel') {
    if (p.check_in_date === TOMORROW)  return p.check_in_time  || '00:00';
    if (p.check_out_date === TOMORROW) return p.check_out_time || '00:00';
    return '00:00';
  }
  return primaryTime(p);
}

function isPast(p) { return itemState(p) === 'spent'; }

function formatCountdown(timeStr) {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [h, m] = (timeStr || '').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const diff = h * 60 + m - nowMins;
  if (diff <= 0) return null;
  const hrs = Math.floor(diff / 60);
  const mins = diff % 60;
  return hrs > 0 ? `In ${hrs}h ${mins}m` : `In ${mins}m`;
}

export function renderTodayStrip() {
  const strip = $('today-strip');

  function matchesDate(p, date) {
    if (p.type === 'hotel' && p.check_in_date && p.check_out_date) {
      return p.check_in_date <= date && date <= p.check_out_date;
    }
    if (p.type === 'transport' && p.date) return p.date === date;
    if (p.type === 'activity' && p.reservation_date) return p.reservation_date === date;
    return false;
  }

  const todayItems = s.wikiPages.filter(p => matchesDate(p, TODAY));

  // Hotel checkout-day entries only surface in tomorrow strip from 18:00
  const nowHour = new Date().getHours();
  const tomorrowItems = s.wikiPages.filter(p => {
    if (!matchesDate(p, TOMORROW)) return false;
    if (p.type === 'hotel' && p.check_out_date === TOMORROW && p.check_in_date !== TOMORROW) {
      return nowHour >= 18;
    }
    return true;
  });

  if (!todayItems.length && !tomorrowItems.length) { strip.innerHTML = ''; return; }

  todayItems.sort((a, b) => primaryTime(a).localeCompare(primaryTime(b)));
  tomorrowItems.sort((a, b) => tomorrowPrimaryTime(a).localeCompare(tomorrowPrimaryTime(b)));

  const grouped = {};
  for (const p of todayItems) { (grouped[p.type] = grouped[p.type] || []).push(p); }

  let n = 0;
  let html = '<div class="today-strip-heading">Today</div>';

  for (const type of STRIP_CATEGORY_ORDER) {
    if (!grouped[type]) continue;
    html += `<div class="today-category-header">${STRIP_CATEGORY_LABEL[type]}</div>`;
    const upcomingGroup = grouped[type].filter(p => itemState(p) === 'upcoming');
    const activeGroup   = grouped[type].filter(p => itemState(p) === 'active');
    const spentGroup    = grouped[type].filter(p => itemState(p) === 'spent');
    for (const p of [...upcomingGroup, ...activeGroup, ...spentGroup]) {
      const state = itemState(p);
      const foldHtml = buildFoldHtml(p, n);
      const catClass = STRIP_CATEGORY_CLASS[type] || '';
      const stateClass = state === 'upcoming' ? ' today-item-upcoming'
                       : state === 'spent'    ? ' today-item-past'
                       : '';
      const countdownStr  = state === 'upcoming' ? formatCountdown(primaryTime(p)) : null;
      const countdownHtml = countdownStr ? `<span class="today-item-countdown">${countdownStr}</span>` : '';
      html += `<div class="today-item ${catClass}${stateClass}">
        <div class="today-item-row" data-idx="${n}">
          <span class="today-item-line">${formatTodayLine(p)}</span>
          ${countdownHtml}
          ${foldHtml ? '<span class="today-item-arrow">›</span>' : ''}
        </div>
        ${foldHtml ? `<div class="today-fold" data-idx="${n}">${foldHtml}</div>` : ''}
      </div>`;
      n++;
    }
  }

  if (tomorrowItems.length) {
    html += '<hr class="today-divider">';
    html += '<div class="today-strip-heading">Tomorrow</div>';
    for (const p of tomorrowItems) {
      html += `<div class="today-tomorrow-item"><span class="today-item-line">${formatTomorrowLine(p)}</span></div>`;
    }
  }

  strip.innerHTML = html;

  strip.querySelectorAll('.today-item-row[data-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const i = row.dataset.idx;
      const fold = strip.querySelector(`.today-fold[data-idx="${i}"]`);
      if (!fold) return;
      const opening = !fold.classList.contains('open');
      fold.classList.toggle('open', opening);
      const arrow = row.querySelector('.today-item-arrow');
      if (arrow) arrow.textContent = opening ? '∨' : '›';
      const item = row.closest('.today-item');
      if (item) item.classList.toggle('today-item-expanded', opening);
      if (opening) loadTodaySourceFile(fold);
    });
  });
}

async function loadTodaySourceFile(foldEl) {
  if (!s.vault) return;
  const sourceRows = foldEl.querySelectorAll('.today-source-row');
  for (const sourceRow of sourceRows) {
    if (sourceRow.dataset.loaded) continue;
    const sourcePath = sourceRow.dataset.source;
    if (!sourcePath) continue;
    const label = sourceRow.querySelector('.today-source-label');
    const contentEl = sourceRow.querySelector('.today-source-content');
    try {
      const text = await vault.readSourceFile(s.vault, sourcePath);
      if (text !== null) {
        contentEl.textContent = text;
        contentEl.style.display = '';
      } else {
        label.textContent = 'Original capture (unavailable)';
      }
    } catch {
      label.textContent = 'Original capture (unavailable)';
    }
    sourceRow.dataset.loaded = '1';
  }
}

// ---- Test fixture ----
export function renderTestStrip() {
  const testPages = [
    {
      type: 'transport', subtype: 'flight', name: 'Flight SK 683 — Copenhagen to Rome',
      departure_time: '06:45', departure_point: 'Copenhagen Airport (CPH), Terminal 2',
      arrival_time: '10:05', arrival_point: 'Rome Fiumicino Airport (FCO), Terminal 3',
      airline: 'SAS', booking_reference: 'SKAS7X',
      special_notes: 'Meal: Standard included.',
      reservation_items: ['Seat 14A (Passenger A)', 'Seat 14B (Passenger B)'],
      lat: 55.618, lon: 12.656, sources: [],
    },
    {
      type: 'hotel', name: 'Hotel Tornabuoni Roma',
      check_in_date: TODAY, check_out_date: (() => { const d = new Date(TODAY + 'T12:00:00'); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10); })(),
      check_in_time: '13:00', check_out_time: '12:00',
      check_in_time_weekend: '14:00', check_out_time_weekend: '12:00',
      booking_reference: 'HTC-88421-R',
      phone: '+39 06 6784 2200', website_url: 'https://www.tornabuoniroma.it',
      address: 'Via del Corso 12, 00186 Roma RM, Italy',
      laundry: 'Basement B1. Coin op, €4/wash.',
      room_service_url: '', maps_url: '',
      special_notes: 'No front desk after 23:00.',
      reservation_items: ['Early check-in 13:00 confirmed'],
      lat: 41.9009, lon: 12.4833, sources: [],
    },
    {
      type: 'activity', name: 'Colosseum Guided Tour',
      reservation_time: '09:00', booking_reference: 'GYG-554821',
      meeting_point: 'Outside main entrance, Piazza del Colosseo 1, Roma',
      details_url: 'https://example.com', maps_url: '',
      special_notes: 'Small group, max 12.',
      reservation_items: ['Audio headset included', '2 participants'],
      lat: 41.8902, lon: 12.4922, sources: [],
    },
  ];

  const grouped = {};
  for (const p of testPages) { (grouped[p.type] = grouped[p.type] || []).push(p); }

  let n = 0;
  let html = '<div class="today-strip-heading">Today (test)</div>';

  for (const type of STRIP_CATEGORY_ORDER) {
    if (!grouped[type]) continue;
    html += `<div class="today-category-header">${STRIP_CATEGORY_LABEL[type]}</div>`;
    for (const p of grouped[type]) {
      const foldHtml = buildFoldHtml(p, n);
      const catClass = STRIP_CATEGORY_CLASS[type] || '';
      html += `<div class="today-item ${catClass}">
        <div class="today-item-row" data-idx="${n}">
          <span class="today-item-line">${formatTodayLine(p)}</span>
          <span class="today-item-arrow">›</span>
        </div>
        <div class="today-fold" data-idx="${n}">${foldHtml}</div>
      </div>`;
      n++;
    }
  }

  const strip = $('today-strip');
  strip.innerHTML = html;

  strip.querySelectorAll('.today-item-row[data-idx]').forEach(row => {
    row.addEventListener('click', () => {
      const i = row.dataset.idx;
      const fold = strip.querySelector(`.today-fold[data-idx="${i}"]`);
      if (!fold) return;
      const opening = !fold.classList.contains('open');
      fold.classList.toggle('open', opening);
      const arrow = row.querySelector('.today-item-arrow');
      if (arrow) arrow.textContent = opening ? '∨' : '›';
    });
  });

  // Switch to wiki tab so the strip is visible
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'wiki'));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-wiki'));
  console.log('[TV] Test strip rendered — 3 cards (hotel, transport, activity)');
}
window.renderTestStrip = renderTestStrip;
