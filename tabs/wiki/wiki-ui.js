// Wiki tab — list rendering + article view (hotel card and generic article).
// Today/tomorrow strip lives in today-strip.js.
import { $, esc, fmtDate } from '../../core/ui.js';
import { s } from '../../core/state.js';
import { sample as sampleGps, pickNearestSlug, haversineKm } from '../../services/location.js';
import { getActiveSlug } from '../../services/trip-context.js';

const TYPE_LABEL = { hotel: 'Hotels', restaurant: 'Restaurants', activity: 'Activities', transport: 'Transport', area: 'Areas', food: 'Food', guide: 'Guides' };
const TYPE_ORDER = ['hotel', 'restaurant', 'activity', 'transport', 'area', 'food', 'guide'];

let selectedSlug = '';
let areaSet = [];   // [{ slug, name, area_path, area_path_display, has_page }]
let userPicked = false;
let gpsAttempted = false;
let gpsResult = null;     // last successful GPS sample, or null on denial

// Smart-revert override storage. Trip-scoped so switching trips doesn't
// reuse a stale pick. Cleared automatically when (a) the day rolls over or
// (b) the user has moved more than ~2 km from the basis GPS.
const REVERT_KM = 2;
function todayISO() { return new Date().toISOString().slice(0, 10); }
function overrideKey(tripSlug) { return `tv-phone-area-override:${tripSlug || '_'}`; }
function loadOverride(tripSlug) {
  try {
    const raw = localStorage.getItem(overrideKey(tripSlug));
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.slug !== 'string' || typeof o.basisDate !== 'string') return null;
    return o;
  } catch { return null; }
}
function saveOverride(tripSlug, slug, gps) {
  try {
    const payload = { slug, basisDate: todayISO() };
    if (gps && typeof gps.lat === 'number' && typeof gps.lon === 'number') payload.basisGps = gps;
    localStorage.setItem(overrideKey(tripSlug), JSON.stringify(payload));
  } catch (err) { console.error('[wiki-ui] saveOverride failed:', err.message); }
}
function clearOverride(tripSlug) {
  try { localStorage.removeItem(overrideKey(tripSlug)); }
  catch (err) { console.error('[wiki-ui] clearOverride failed:', err.message); }
}

export function setupWikiTab() {
  // Legacy search input is hidden in the shell behind [hidden] but still
  // wired so re-surfacing it is a one-line markup change.
  const search = $('wiki-search');
  if (search) search.addEventListener('input', e => renderWikiList(e.target.value.toLowerCase().trim()));
  const sel = $('wiki-area');
  if (sel) sel.addEventListener('change', e => {
    selectedSlug = e.target.value || '';
    userPicked = true;
    saveOverride(getActiveSlug(), selectedSlug, gpsResult);
    renderWikiList((search?.value || '').toLowerCase().trim());
    renderAreaPanel();
  });
  $('article-back').addEventListener('click', () => $('wiki-article').classList.remove('open'));
}

function titleCaseSlug(slug) {
  return slug.split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
}

// Builds the area set client-side from the loaded pages: union of every
// type=area page AND every unique slug discovered in any page's area_path.
// Mirrors the laptop's /api/wiki/areas server logic so behaviour matches.
export function rebuildAreaSet() {
  const areaPageBySlug = new Map();
  for (const p of s.wikiPages || []) if (p.type === 'area') areaPageBySlug.set(p.slug, p);

  const inferredPath = new Map();
  for (const p of s.wikiPages || []) {
    const ap = Array.isArray(p.area_path) ? p.area_path : [];
    for (let i = 0; i < ap.length; i++) {
      const slug = ap[i];
      if (!inferredPath.has(slug)) inferredPath.set(slug, ap.slice(i));
    }
  }

  const displayName = (slug) => {
    const page = areaPageBySlug.get(slug);
    if (page && page.name) return page.name;
    return titleCaseSlug(slug);
  };

  const allSlugs = new Set([...areaPageBySlug.keys(), ...inferredPath.keys()]);
  areaSet = [];
  for (const slug of allSlugs) {
    const page = areaPageBySlug.get(slug);
    const areaPath = (page && Array.isArray(page.area_path) && page.area_path.length)
      ? page.area_path
      : (inferredPath.get(slug) || [slug]);
    areaSet.push({
      slug,
      name: displayName(slug),
      area_path: areaPath,
      area_path_display: areaPath.map(displayName).join(' · '),
      has_page: !!page,
    });
  }
  areaSet.sort((a, b) => a.area_path_display.localeCompare(b.area_path_display));

  // Re-evaluate the active filter from scratch on every load — override
  // first (if still valid by date), else clear to '' so applyNearMe picks
  // the GPS-nearest area on the next call.
  resolveOverrideOrReset();
  populateAreaSelect();
  renderAreaPanel();
}

// Day-rollover revert + override-still-applies check. GPS-shift revert is
// deferred until we actually have a fresh GPS sample (in applyNearMe).
function resolveOverrideOrReset() {
  const tripSlug = getActiveSlug();
  const override = loadOverride(tripSlug);
  if (!override) {
    selectedSlug = ''; userPicked = false;
    return;
  }
  if (override.basisDate !== todayISO()) {
    clearOverride(tripSlug);
    selectedSlug = ''; userPicked = false;
    return;
  }
  if (override.slug !== '' && !areaSet.some(a => a.slug === override.slug)) {
    // Stale override slug (page deleted, area renamed, trip reset) — drop it.
    clearOverride(tripSlug);
    selectedSlug = ''; userPicked = false;
    return;
  }
  selectedSlug = override.slug;
  userPicked = true;
}

// "Near me" + smart-revert. On phone the GPS sample serves two purposes:
// (a) check whether an active override has drifted >2 km from its basis
// (smart-revert), and (b) pick the nearest area when no override is active.
// Sample once per session — permission prompts shouldn't repeat.
export async function applyNearMe() {
  const tripSlug = getActiveSlug();

  // GPS-shift smart-revert: only relevant if the active override has a
  // basisGps to compare against. Sample lazily.
  if (userPicked) {
    const override = loadOverride(tripSlug);
    if (override && override.basisGps) {
      if (!gpsAttempted) {
        gpsAttempted = true;
        gpsResult = await sampleGps({ timeout: 8000, maximumAge: 5 * 60_000 });
      }
      if (gpsResult && haversineKm(override.basisGps, gpsResult) > REVERT_KM) {
        clearOverride(tripSlug);
        userPicked = false;
        selectedSlug = '';
        // Fall through to the near-me branch below so the dropdown gets a
        // fresh default, not just an empty "All areas".
      }
    }
  }

  if (userPicked || selectedSlug) return;

  if (!gpsAttempted) {
    gpsAttempted = true;
    gpsResult = await sampleGps({ timeout: 8000, maximumAge: 5 * 60_000 });
  }
  if (!gpsResult) return;

  const candidates = (s.wikiPages || [])
    .filter(p => p.type === 'area' && typeof p.lat === 'number' && typeof p.lon === 'number')
    .map(p => ({ slug: p.slug, lat: p.lat, lon: p.lon }));
  const slug = pickNearestSlug(candidates, gpsResult);
  if (slug && areaSet.some(a => a.slug === slug)) {
    selectedSlug = slug;
    populateAreaSelect();
    renderWikiList('');
    renderAreaPanel();
  }
}

// ── Area intro panel ──────────────────────────────────────────────────────
//
// Sits between the cap-row and the area dropdown. Visible only when the
// active filter is an area that has its own wiki/areas/<slug>.md page;
// collapsed by default, tap to expand. Shows the five "panel sections" from
// the area schema; empty sections are skipped.

const PANEL_SECTIONS = [
  { key: 'food_and_drink',        label: 'Food & drink' },
  { key: 'sights_and_doing',      label: 'Sights & doing' },
  { key: 'local_rhythms',         label: 'Local rhythms' },
  { key: 'customs_and_etiquette', label: 'Customs & etiquette' },
  { key: 'getting_around',        label: 'Getting around' },
];

let panelOpen = false;

function renderAreaPanel() {
  const el = $('wiki-area-panel');
  if (!el) return;
  // Source from the already-loaded s.wikiPages; if the active slug doesn't
  // have a type=area page, hide the panel entirely.
  const page = (s.wikiPages || []).find(p => p.type === 'area' && p.slug === selectedSlug);
  if (!selectedSlug || !page) { el.hidden = true; el.innerHTML = ''; return; }

  const sections = extractSections(page.content || '', PANEL_SECTIONS.map(s => s.key));
  const filledSections = PANEL_SECTIONS.filter(s => sections[s.key] && sections[s.key].trim());
  const sectionsHtml = filledSections.length
    ? filledSections.map(s => `
        <div class="wiki-area-panel-section">
          <div class="wiki-area-panel-section-title">${esc(s.label)}</div>
          ${renderPanelSection(sections[s.key])}
        </div>
      `).join('')
    : '<div class="wiki-area-panel-empty">No intro yet — open the area page on the laptop and run “Find more”.</div>';

  el.hidden = false;
  el.classList.toggle('open', panelOpen);
  el.innerHTML =
    `<button type="button" class="wiki-area-panel-bar" aria-expanded="${panelOpen}">` +
      `<span><span class="wiki-area-panel-icon">📍</span> ${esc(page.name)}</span>` +
      `<span class="wiki-area-panel-arrow">›</span>` +
    `</button>` +
    `<div class="wiki-area-panel-body">${sectionsHtml}</div>`;
  el.querySelector('.wiki-area-panel-bar').addEventListener('click', () => {
    panelOpen = !panelOpen;
    el.classList.toggle('open', panelOpen);
    el.querySelector('.wiki-area-panel-bar').setAttribute('aria-expanded', String(panelOpen));
  });
}

function extractSections(body, keys) {
  const result = {};
  if (!body) return result;
  const chunks = ('\n' + body).split(/\n## /m);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const newlineIdx = trimmed.indexOf('\n');
    const heading = (newlineIdx > -1 ? trimmed.slice(0, newlineIdx) : trimmed).trim();
    const content = (newlineIdx > -1 ? trimmed.slice(newlineIdx + 1) : '').trim();
    const key = heading.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (keys.includes(key)) result[key] = content;
  }
  return result;
}

function renderPanelSection(content) {
  const text = content.replace(/\[\d+\]/g, '').trim();
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length && lines.every(l => l.startsWith('- '))) {
    const items = lines.map(l => `<li>${renderInlineMd(l.replace(/^-\s+/, ''))}</li>`).join('');
    return `<ul>${items}</ul>`;
  }
  return text.split(/\n{2,}/).map(p => `<p>${renderInlineMd(p)}</p>`).join('');
}

function renderInlineMd(text) {
  let html = esc(text);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  return html;
}

function populateAreaSelect() {
  const sel = $('wiki-area');
  if (!sel) return;
  const current = selectedSlug;
  sel.innerHTML = '<option value="">All areas</option>' + areaSet.map(a =>
    `<option value="${esc(a.slug)}">${esc(a.area_path_display)}</option>`
  ).join('');
  if (current && areaSet.some(a => a.slug === current)) sel.value = current;
  else { sel.value = ''; selectedSlug = ''; }
}

function pageInArea(p, slug) {
  return Array.isArray(p.area_path) && p.area_path.includes(slug);
}

function subAreaSlugFor(page, slug) {
  const ap = page.area_path || [];
  const idx = ap.indexOf(slug);
  if (idx <= 0) return null;
  return ap[idx - 1];
}

export function renderWikiList(query) {
  const el = $('wiki-list');
  let pages = s.wikiPages || [];
  if (selectedSlug) pages = pages.filter(p => pageInArea(p, selectedSlug));
  if (query) {
    pages = pages.filter(p =>
      p.name.toLowerCase().includes(query) ||
      (p.area_display || '').toLowerCase().includes(query) ||
      p.tags.some(t => t.toLowerCase().includes(query)));
  }

  if (!pages.length) { el.innerHTML = '<p class="empty-state">No pages</p>'; return; }

  const subAreaSlugs = selectedSlug
    ? pages.map(p => subAreaSlugFor(p, selectedSlug)).filter(s => s !== null)
    : [];
  const groupBySubArea = subAreaSlugs.length > 0;

  const sectionsHtml = groupBySubArea
    ? renderBySubArea(pages)
    : renderByType(pages);

  el.innerHTML = sectionsHtml;

  if (query) {
    el.querySelectorAll('.wiki-accordion-header').forEach(h => h.classList.add('open'));
    el.querySelectorAll('.wiki-accordion-body').forEach(b => b.classList.add('open'));
  }

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

function itemHtml(p) {
  return `<div class="wiki-item" data-slug="${esc(p.slug)}" data-type="${esc(p.type)}">` +
    `<div>` +
      `<div class="wiki-name">${esc(p.name)}</div>` +
      (p.area_display ? `<div class="wiki-area">${esc(p.area_display)}</div>` : '') +
    `</div>` +
    (p.rating ? `<span class="wiki-rating">${'★'.repeat(+p.rating)}</span>` : '') +
  `</div>`;
}

function sectionHtml(label, items) {
  return `<div class="wiki-accordion-section">` +
    `<button class="wiki-accordion-header">` +
      `<span>${esc(label)}</span>` +
      `<span class="wiki-accordion-arrow">›</span>` +
    `</button>` +
    `<div class="wiki-accordion-body">${items.map(itemHtml).join('')}</div>` +
  `</div>`;
}

function renderByType(pages) {
  const grouped = {};
  for (const p of pages) { (grouped[p.type] ||= []).push(p); }
  for (const t of Object.keys(grouped)) {
    grouped[t].sort((a, b) => a.name.localeCompare(b.name));
  }
  return TYPE_ORDER
    .filter(type => grouped[type])
    .map(type => sectionHtml(TYPE_LABEL[type] || type, grouped[type]))
    .join('');
}

function renderBySubArea(pages) {
  const nameBySlug = new Map();
  for (const a of areaSet) nameBySlug.set(a.slug, a.name);

  const grouped = {};
  for (const p of pages) {
    const sub = subAreaSlugFor(p, selectedSlug);
    const key = sub || `__direct__:${selectedSlug}`;
    (grouped[key] ||= []).push(p);
  }
  for (const k of Object.keys(grouped)) {
    grouped[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  const directKey = `__direct__:${selectedSlug}`;
  const subKeys = Object.keys(grouped).filter(k => k !== directKey)
    .sort((a, b) => (nameBySlug.get(a) || a).localeCompare(nameBySlug.get(b) || b));
  const ordered = [...subKeys];
  if (grouped[directKey]) ordered.push(directKey);

  return ordered.map(key => {
    const label = key === directKey
      ? `In ${nameBySlug.get(selectedSlug) || selectedSlug}`
      : (nameBySlug.get(key) || key);
    return sectionHtml(label, grouped[key]);
  }).join('');
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
  if (page.area_display) rows.push(row('Area', page.area_display));
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
  if (page.area_display) rows.push(row('Area', page.area_display));
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
