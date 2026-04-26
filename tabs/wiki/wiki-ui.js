// Wiki tab — list rendering + article view (hotel card and generic article).
// Today/tomorrow strip lives in today-strip.js.
import { $, esc, fmtDate } from '../../core/ui.js';
import { s } from '../../core/state.js';

const TYPE_LABEL = { hotel: 'Hotels', restaurant: 'Restaurants', activity: 'Activities', transport: 'Transport', area: 'Areas' };
const TYPE_ORDER = ['hotel', 'restaurant', 'activity', 'transport', 'area'];

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

export function openArticle(page) {
  const hotelCardEl = $('article-hotel-card');
  const mapsLinkEl  = $('article-maps-link');
  const contentEl   = $('article-content');

  if (page.type === 'hotel') {
    hotelCardEl.innerHTML = buildHotelCard(page);
    hotelCardEl.style.display = '';
    mapsLinkEl.hidden = true;
    contentEl.textContent = '';
  } else {
    hotelCardEl.innerHTML = '';
    hotelCardEl.style.display = 'none';
    contentEl.textContent = `${page.name}\n\n${page.content}`;
    if (page.maps_url && ['restaurant', 'activity', 'area'].includes(page.type)) {
      mapsLinkEl.innerHTML = `<a href="${esc(page.maps_url)}" target="_blank" rel="noopener">Open in Maps →</a>`;
      mapsLinkEl.hidden = false;
    } else {
      mapsLinkEl.innerHTML = '';
      mapsLinkEl.hidden = true;
    }
  }
  $('wiki-article').classList.add('open');
}

export function buildHotelCard(page) {
  const parts = [];

  parts.push(`<h2 class="hotel-card-name">${esc(page.name)}</h2>`);

  if (page.booking_reference) {
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Booking ref</div>` +
        `<div class="hotel-card-booking-ref">${esc(page.booking_reference)}</div>` +
      `</div>`
    );
  }

  const stayRows = [];
  if (page.check_in_date || page.check_in_time) {
    const val = [page.check_in_date ? fmtDate(page.check_in_date) : null, page.check_in_time].filter(Boolean).join(' · ');
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Check-in</span><span>${esc(val)}</span></div>`);
  }
  if (page.check_out_date || page.check_out_time) {
    const val = [page.check_out_date ? fmtDate(page.check_out_date) : null, page.check_out_time].filter(Boolean).join(' · ');
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Check-out</span><span>${esc(val)}</span></div>`);
  }
  if (page.breakfast_included !== null) {
    const val = page.breakfast_included
      ? `Included${page.breakfast_time ? ` · ${page.breakfast_time}` : ''}`
      : 'Not included';
    stayRows.push(`<div class="hotel-stay-row"><span class="hotel-stay-key">Breakfast</span><span>${esc(val)}</span></div>`);
  }
  if (stayRows.length) {
    parts.push(`<div class="hotel-card-section">${stayRows.join('')}</div>`);
  }

  if (page.reservation_items && page.reservation_items.length) {
    const items = page.reservation_items.map(item => `<li>${esc(item)}</li>`).join('');
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Confirmed</div>` +
        `<ul class="hotel-card-list">${items}</ul>` +
      `</div>`
    );
  }

  if (page.special_notes) {
    parts.push(
      `<div class="hotel-card-section">` +
        `<div class="hotel-card-label">Notes</div>` +
        `<div class="hotel-card-notes">${esc(page.special_notes)}</div>` +
      `</div>`
    );
  }

  const links = [];
  if (page.maps_url) {
    links.push(`<a href="${esc(page.maps_url)}" target="_blank" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  } else if (page.lat != null && page.lon != null) {
    const geoUri = `geo:${page.lat},${page.lon}?q=${page.lat},${page.lon}`;
    links.push(`<a href="${esc(geoUri)}" rel="noopener" class="hotel-card-link">Open in Maps →</a>`);
  }
  if (page.room_service_url) {
    links.push(`<a href="${esc(page.room_service_url)}" target="_blank" rel="noopener" class="hotel-card-link">Hotel website →</a>`);
  }
  if (links.length) {
    parts.push(`<div class="hotel-card-links">${links.join('')}</div>`);
  }

  if (page.content) {
    parts.push(`<hr class="hotel-card-divider"><div class="hotel-card-body">${esc(page.content)}</div>`);
  }

  return parts.join('');
}
