// Wiki page loader — fetches all wiki pages from the private data repo via GitHub.
// Phase 3 replacement for the FSA path in vault.js. Returns the same shape
// the rest of the PWA already consumes, so no downstream rendering changes.

import { listDir, getFile, GitHubNotFoundError } from './github.js';
import { wikiPath } from './trip-context.js';

const FOLDERS = {
  hotels:      'hotel',
  restaurants: 'restaurant',
  activities:  'activity',
  transport:   'transport',
  areas:       'area',
  food:        'food',
  guides:      'guide',
};

export async function loadWikiPages() {
  const folderResults = await Promise.all(
    Object.entries(FOLDERS).map(async ([folder, type]) => {
      let entries;
      try {
        entries = await listDir(wikiPath(folder));
      } catch (e) {
        if (e instanceof GitHubNotFoundError) return [];
        throw e;
      }
      const mdFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.md'));
      const pages = await Promise.all(mdFiles.map(async file => {
        try {
          const { content } = await getFile(file.path);
          return parsePage(content, type, file.name.slice(0, -3));
        } catch {
          return null;
        }
      }));
      return pages.filter(Boolean);
    })
  );
  const pages = folderResults.flat();

  // Resolve each page's area_path leaf to a display name once (using the
  // area pages' own `name` field, falling back to a title-cased slug). The
  // wiki list and article cards read page.area_display directly so they
  // don't need to re-derive on every render.
  const areaNameBySlug = new Map();
  for (const p of pages) if (p.type === 'area') areaNameBySlug.set(p.slug, p.name);
  for (const p of pages) {
    const leaf = Array.isArray(p.area_path) && p.area_path.length ? p.area_path[0] : '';
    p.area_display = leaf ? (areaNameBySlug.get(leaf) || titleCaseSlug(leaf)) : '';
  }
  return pages;
}

function titleCaseSlug(slug) {
  return slug.split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ');
}

function parseFrontmatter(yamlText) {
  const fm = {};
  const lines = yamlText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) { i++; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key  = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    i++;
    if (rest === '' || rest === 'null' || rest === '~') {
      const items = [];
      while (i < lines.length && /^  - /.test(lines[i])) {
        items.push(lines[i].replace(/^  - /, '').replace(/^['"]|['"]$/g, '').trim());
        i++;
      }
      fm[key] = items.length > 0 ? items : null;
    } else if (rest === '[]') {
      fm[key] = [];
    } else if (rest === 'true') {
      fm[key] = true;
    } else if (rest === 'false') {
      fm[key] = false;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      fm[key] = inner
        ? inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        : [];
    } else {
      fm[key] = rest.replace(/^['"]|['"]$/g, '');
    }
  }
  return fm;
}

function parsePage(text, type, slug) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = parseFrontmatter(m[1]);
  const tags = Array.isArray(fm.tags)
    ? fm.tags
    : (typeof fm.tags === 'string'
        ? fm.tags.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
        : []);
  const latM = m[1].match(/^\s+lat:\s*(-?[\d.]+)/m);
  const lonM = m[1].match(/^\s+lon:\s*(-?[\d.]+)/m);
  const lat = latM ? parseFloat(latM[1]) : null;
  const lon = lonM ? parseFloat(lonM[1]) : null;
  return {
    type, slug,
    name:   fm.name || slug,
    area:   fm.area || '',
    area_path: Array.isArray(fm.area_path) ? fm.area_path : [],
    rating: fm.rating_personal || null,
    tags,
    content: m[2].trim(),
    booking_reference: fm.booking_reference || null,
    check_in_date:    fm.check_in_date  || null,
    check_out_date:   fm.check_out_date || null,
    check_in_time:    fm.check_in_time  || null,
    check_out_time:   fm.check_out_time || null,
    check_in_time_weekend:  fm.check_in_time_weekend  || null,
    check_out_time_weekend: fm.check_out_time_weekend || null,
    breakfast_included: fm.breakfast_included ?? null,
    breakfast_time:   fm.breakfast_time  || null,
    laundry:          fm.laundry         || null,
    room_service_url: fm.room_service_url || null,
    phone:            fm.phone           || null,
    website_url:      fm.website_url     || null,
    address:          fm.address         || null,
    subtype:          fm.subtype          || null,
    airline:          fm.airline          || null,
    date:             fm.date             || null,
    departure_time:   fm.departure_time   || null,
    departure_point:  fm.departure_point  || null,
    arrival_time:     fm.arrival_time     || null,
    arrival_point:    fm.arrival_point    || null,
    reservation_date: fm.reservation_date || null,
    reservation_time: fm.reservation_time || null,
    duration:         fm.duration         || null,
    meeting_point:    fm.meeting_point    || null,
    details_url:      fm.details_url      || null,
    special_notes:    fm.special_notes    || null,
    reservation_items: Array.isArray(fm.reservation_items) ? fm.reservation_items : [],
    sources: Array.isArray(fm.sources)
      ? fm.sources
      : (fm.sources ? [fm.sources] : (fm.source ? [fm.source] : [])),
    lat, lon,
    maps_url: fm.maps_url || null,
  };
}
