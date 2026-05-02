// Wiki tab — list rendering + article view (hotel card and generic article).
// Today/tomorrow strip lives in today-strip.js.
import { $, esc, fmtDate } from '../../core/ui.js';
import { s } from '../../core/state.js';

const TYPE_LABEL = { hotel: 'Hotels', restaurant: 'Restaurants', activity: 'Activities', transport: 'Transport', area: 'Areas', food: 'Food', guide: 'Guides' };
const TYPE_ORDER = ['hotel', 'restaurant', 'activity', 'transport', 'area', 'food', 'guide'];

export function setupWikiTab() {
  $('wiki-search').addEventListener('input', e => renderWikiList(e.target.value.toLowerCase().trim()));
  $('article-back').addEventListener('click', () => $('wiki-article').classList.remove('open'));
}

export function renderWikiList(query) {
  const el = $('wiki-list');
  const pages = query
    ? s.wikiPages.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.area.toLowerCase().includes(query) ||
        p.tags.some(t => t.toLowerCase().includes(query)))
    : s.wikiPages;

  if (!pages.length) { el.innerHTML = '<p class="empty-state">No pages</p>'; return; }

  const grouped = {};
  for (const p of pages) { if (!grouped[p.type]) grouped[p.type] = []; grouped[p.type].push(p); }

  el.innerHTML = TYPE_ORDER
    .filter(type => grouped[type])
    .map(type => {
      const items = grouped[type];
      return `<div class="wiki-accordion-section">` +
        `<button class="wiki-accordion-header" data-type="${type}">` +
          `<span>${esc(TYPE_LABEL[type] || type)}</span>` +
          `<span class="wiki-accordion-arrow">›</span>` +
        `</button>` +
        `<div class="wiki-accordion-body">` +
          items.map(p =>
            `<div class="wiki-item" data-slug="${esc(p.slug)}" data-type="${esc(p.type)}">` +
              `<div>` +
                `<div class="wiki-name">${esc(p.name)}</div>` +
                (p.area ? `<div class="wiki-area">${esc(p.area)}</div>` : '') +
              `</div>` +
              (p.rating ? `<span class="wiki-rating">${'★'.repeat(+p.rating)}</span>` : '') +
            `</div>`
          ).join('') +
        `</div>` +
      `</div>`;
    }).join('');

  // When searching, expand all matching sections so results are immediately visible
  if (query) {
    el.querySelectorAll('.wiki-accordion-header').forEach(h => h.classList.add('open'));
    el.querySelectorAll('.wiki-accordion-body').forEach(b => b.classList.add('open'));
  }

  // Accordion toggle — one section open at a time
  el.querySelectorAll('.wiki-accordion-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      const opening = !body.classList.contains('open');
      el.querySelectorAll('.wiki-accordion-header').forEach(h => h.classList.remove('open'));
      el.querySelectorAll('.wiki-accordion-body').forEach(b => b.classList.remove('open'));
      if (opening) {
        header.classList.add('open');
        body.classList.add('open');
      }
    });
  });

  el.querySelectorAll('.wiki-item').forEach(item => item.addEventListener('click', () => {
    const page = s.wikiPages.find(p => p.slug === item.dataset.slug && p.type === item.dataset.type);
    if (page) openArticle(page);
  }));
}

// Types that get the structured details card up top. Body sections (area /
// food / guide) skip the card and render as plain prose.
const CARD_TYPES = new Set(['hotel', 'restaurant', 'activity', 'transport']);

export function openArticle(page) {
  const hotelCardEl = $('article-hotel-card'); // legacy id; reused as the generic details container
  const mapsLinkEl  = $('article-maps-link');
  const contentEl   = $('article-content');

  if (CARD_TYPES.has(page.type)) {
    hotelCardEl.innerHTML = buildArticleCard(page);
    hotelCardEl.style.display = '';
    // The card already includes the maps link when relevant, so drop the
    // separate stub.
    mapsLinkEl.hidden = true;
    mapsLinkEl.innerHTML = '';
    contentEl.textContent = '';
  } else {
    hotelCardEl.innerHTML = '';
    hotelCardEl.style.display = 'none';
    contentEl.textContent = `${page.name}\n\n${page.content}`;
    if (page.maps_url) {
      mapsLinkEl.innerHTML = `<a href="${esc(page.maps_url)}" target="_blank" rel="noopener">Open in Maps →</a>`;
      mapsLinkEl.hidden = false;
    } else {
      mapsLinkEl.innerHTML = '';
      mapsLinkEl.hidden = true;
    }
  }
  $('wiki-article').classList.add('open');
}

// ── Generic article card ───────────────────────────────────────────────────
// Reuses the .hotel-card-* CSS as the visual chassis (it's been generic
// since day one — name / section / label / value / links / body). Each
// type contributes its own set of operational rows; everything renders
// in the same order so the most operational facts (booking ref, date /
// time, contact) are always at the top.

function row(key, value) {
  return `<div class="hotel-stay-row"><span class="hotel-stay-key">${esc(key)}</span><span>${esc(value)}</span></div>`;
}

function bookingRefBlock(page) {
  if (!page.booking_reference) return '';
  return `<div class="hotel-card-section">` +
    `<div class="hotel-card-label">Booking ref</div>` +
    `<div class="hotel-card-booking-ref">${esc(page.booking_reference)}</div>` +
    `</div>`;
}

function notesBlock(page) {
  if (!page.special_notes) return '';
  return `<div class="hotel-card-section">` +
    `<div class="hotel-card-label">Notes</div>` +
    `<div class="hotel-card-notes">${esc(page.special_notes)}</div>` +
    `</div>`;
}

function itemsBlock(page) {
  if (!page.reservation_items || !page.reservation_items.length) return '';
  const items = page.reservation_items.map(it => `<li>${esc(it)}</li>`).join('');
  return `<div class="hotel-card-section">` +
    `<div class="hotel-card-label">Confirmed</div>` +
    `<ul class="hotel-card-list">${items}</ul>` +
    `</div>`;
}

function linksBlock(page) {
  const links = [];
  if (page.maps_url) {
    links.push(`<a href="${esc(page.maps_url)}" target="_blank" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  } else if (page.lat != null && page.lon != null) {
    const geoUri = `geo:${page.lat},${page.lon}?q=${page.lat},${page.lon}`;
    links.push(`<a href="${esc(geoUri)}" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  }
  if (page.website_url) {
    links.push(`<a href="${esc(page.website_url)}" target="_blank" rel="noopener" class="hotel-card-link">Website →</a>`);
  }
  if (page.room_service_url) {
    links.push(`<a href="${esc(page.room_service_url)}" target="_blank" rel="noopener" class="hotel-card-link">Hotel website →</a>`);
  }
  if (page.details_url) {
    links.push(`<a href="${esc(page.details_url)}" target="_blank" rel="noopener" class="hotel-card-link">Details →</a>`);
  }
  if (page.phone) {
    links.push(`<a href="tel:${esc(page.phone)}" class="hotel-card-link">Call ${esc(page.phone)} →</a>`);
  }
  if (!links.length) return '';
  return `<div class="hotel-card-links">${links.join('')}</div>`;
}

function bodyBlock(page) {
  if (!page.content) return '';
  return `<hr class="hotel-card-divider"><div class="hotel-card-body">${esc(page.content)}</div>`;
}

function detailsRowsForHotel(page) {
  const rows = [];
  if (page.check_in_date || page.check_in_time) {
    rows.push(row('Check-in', [page.check_in_date ? fmtDate(page.check_in_date) : null, page.check_in_time].filter(Boolean).join(' · ')));
  }
  if (page.check_out_date || page.check_out_time) {
    rows.push(row('Check-out', [page.check_out_date ? fmtDate(page.check_out_date) : null, page.check_out_time].filter(Boolean).join(' · ')));
  }
  if (page.breakfast_included !== null) {
    rows.push(row('Breakfast', page.breakfast_included
      ? `Included${page.breakfast_time ? ` · ${page.breakfast_time}` : ''}`
      : 'Not included'));
  }
  if (page.address) rows.push(row('Address', page.address));
  return rows;
}

function detailsRowsForRestaurant(page) {
  const rows = [];
  if (page.reservation_date || page.reservation_time) {
    rows.push(row('Reservation', [page.reservation_date ? fmtDate(page.reservation_date) : null, page.reservation_time].filter(Boolean).join(' · ')));
  }
  if (page.subtype) rows.push(row('Cuisine', page.subtype));
  if (page.area) rows.push(row('Area', page.area));
  if (page.address) rows.push(row('Address', page.address));
  return rows;
}

function detailsRowsForActivity(page) {
  const rows = [];
  if (page.reservation_date || page.reservation_time) {
    rows.push(row('Reservation', [page.reservation_date ? fmtDate(page.reservation_date) : null, page.reservation_time].filter(Boolean).join(' · ')));
  }
  if (page.duration) rows.push(row('Duration', page.duration));
  if (page.meeting_point) rows.push(row('Meeting point', page.meeting_point));
  if (page.subtype) rows.push(row('Type', page.subtype));
  if (page.area) rows.push(row('Area', page.area));
  if (page.address) rows.push(row('Address', page.address));
  return rows;
}

function detailsRowsForTransport(page) {
  const rows = [];
  if (page.date) rows.push(row('Date', fmtDate(page.date)));
  if (page.airline) rows.push(row('Airline', page.airline));
  if (page.departure_time || page.departure_point) {
    rows.push(row('Departs', [page.departure_time, page.departure_point].filter(Boolean).join(' · ')));
  }
  if (page.arrival_time || page.arrival_point) {
    rows.push(row('Arrives', [page.arrival_time, page.arrival_point].filter(Boolean).join(' · ')));
  }
  if (page.subtype) rows.push(row('Type', page.subtype));
  return rows;
}

const DETAILS_FOR = {
  hotel:      detailsRowsForHotel,
  restaurant: detailsRowsForRestaurant,
  activity:   detailsRowsForActivity,
  transport:  detailsRowsForTransport,
};

export function buildArticleCard(page) {
  const parts = [`<h2 class="hotel-card-name">${esc(page.name)}</h2>`];
  parts.push(bookingRefBlock(page));
  const detailsFn = DETAILS_FOR[page.type];
  if (detailsFn) {
    const rows = detailsFn(page);
    if (rows.length) parts.push(`<div class="hotel-card-section">${rows.join('')}</div>`);
  }
  parts.push(itemsBlock(page));
  parts.push(notesBlock(page));
  parts.push(linksBlock(page));
  parts.push(bodyBlock(page));
  return parts.filter(Boolean).join('');
}

// Backwards-compatible export so any existing caller keeps working.
export const buildHotelCard = buildArticleCard;
