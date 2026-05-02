// GPS sampling. Failure resolves to null — never throws.
// timeout/maximumAge are caller-controlled because the existing call sites
// use two distinct configurations (see STRUCTURE.md decision A).

export function sample({ timeout, maximumAge } = {}) {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      ()  => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge }
    );
  });
}

// Great-circle distance in km between two {lat, lon} points. Used by the
// wiki tab's "Near me" default to pick the closest area page.
export function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const x = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Returns the slug of the candidate closest to the GPS point, or '' when
// the candidate list is empty or no candidate has valid coords. Candidates
// shape: [{ slug, lat, lon }].
export function pickNearestSlug(candidates, gps) {
  if (!gps || !candidates || !candidates.length) return '';
  let bestSlug = '';
  let bestKm = Infinity;
  for (const c of candidates) {
    if (typeof c.lat !== 'number' || typeof c.lon !== 'number') continue;
    const km = haversineKm({ lat: c.lat, lon: c.lon }, gps);
    if (km < bestKm) { bestKm = km; bestSlug = c.slug; }
  }
  return bestSlug;
}
