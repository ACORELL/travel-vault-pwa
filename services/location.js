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
