// Minimal JPEG EXIF reader — pulls DateTimeOriginal and GPS only.
// Returns { date: 'YYYY-MM-DD'|null, t: 'YYYY-MM-DDTHH:MM:SS'|null, gps: {lat,lon}|null }.
// Sensitive fields (Make, Model, Software, Artist, Owner, etc.) are never
// parsed or returned — privacy by structure, not by post-filter.

export async function extractMeta(file) {
  try {
    return parseJpeg(await file.arrayBuffer());
  } catch {
    return { date: null, t: null, gps: null };
  }
}

// Back-compat for any caller still importing the old short-form API.
export async function extractTimestamp(file) {
  const m = await extractMeta(file);
  return m.t ? m.t.slice(11, 19) : null;
}

function parseJpeg(buf) {
  const out = { date: null, t: null, gps: null };
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return out;

  let pos = 2;
  while (pos + 4 < view.byteLength) {
    const marker = view.getUint16(pos);
    if (marker === 0xFFDA) break; // start of scan — no more APP segments ahead
    if (marker === 0xFFE1) {
      // APP1: check for "Exif\0\0" header
      if (view.getUint32(pos + 4) === 0x45786966 && view.getUint16(pos + 8) === 0x0000) {
        return parseTiff(buf, pos + 10);
      }
    }
    const segLen = view.getUint16(pos + 2);
    if (segLen < 2) break;
    pos += 2 + segLen;
  }
  return out;
}

function parseTiff(buf, base) {
  const out = { date: null, t: null, gps: null };
  if (base + 8 > buf.byteLength) return out;
  const view = new DataView(buf);
  const le = view.getUint16(base) === 0x4949;
  const u16 = abs => view.getUint16(abs, le);
  const u32 = abs => view.getUint32(abs, le);

  if (u16(base + 2) !== 42) return out;

  const ifd0 = base + u32(base + 4);
  if (ifd0 + 2 > buf.byteLength) return out;
  const n0 = u16(ifd0);

  let exifPtr = null;
  let gpsPtr = null;

  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > buf.byteLength) break;
    const tag = u16(e);
    if (tag === 0x9003) {
      // DateTimeOriginal can also live in IFD0 in older formats — capture it
      // here, but if Exif IFD has one too we'll prefer that (it's the
      // canonical location in modern files).
      const ascii = readAscii(buf, base, e, le);
      if (ascii) {
        out.t = ascii;
        out.date = ascii.slice(0, 10);
      }
    }
    if (tag === 0x8769) exifPtr = base + u32(e + 8);
    if (tag === 0x8825) gpsPtr = base + u32(e + 8);
  }

  if (exifPtr != null && exifPtr + 2 <= buf.byteLength) {
    const n1 = u16(exifPtr);
    for (let i = 0; i < n1; i++) {
      const e = exifPtr + 2 + i * 12;
      if (e + 12 > buf.byteLength) break;
      if (u16(e) === 0x9003) {
        const ascii = readAscii(buf, base, e, le);
        if (ascii) {
          out.t = ascii;
          out.date = ascii.slice(0, 10);
        }
      }
    }
  }

  if (gpsPtr != null && gpsPtr + 2 <= buf.byteLength) {
    out.gps = readGps(buf, base, gpsPtr, le);
  }
  return out;
}

function readAscii(buf, base, entryAbs, le) {
  const view = new DataView(buf);
  const u32 = abs => view.getUint32(abs, le);
  const count = u32(entryAbs + 4);
  const start = base + u32(entryAbs + 8); // DateTimeOriginal is always > 4 bytes, so offset form
  if (start + count > buf.byteLength) return null;
  const str = String.fromCharCode(...new Uint8Array(buf, start, Math.min(count, 24))).replace(/\0.*$/, '');
  const m = str.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : null;
}

function readGps(buf, base, gpsIfd, le) {
  const view = new DataView(buf);
  const u16 = abs => view.getUint16(abs, le);
  const u32 = abs => view.getUint32(abs, le);

  const n = u16(gpsIfd);
  let latRef = null, lat = null, lonRef = null, lon = null;

  for (let i = 0; i < n; i++) {
    const e = gpsIfd + 2 + i * 12;
    if (e + 12 > buf.byteLength) break;
    const tag = u16(e);
    if (tag === 0x0001 || tag === 0x0003) {
      const start = base + u32(e + 8);
      const count = u32(e + 4);
      if (count > 0 && start + 1 <= buf.byteLength) {
        const ch = String.fromCharCode(view.getUint8(start));
        if (tag === 0x0001) latRef = ch; else lonRef = ch;
      }
    }
    if (tag === 0x0002 || tag === 0x0004) {
      const off = base + u32(e + 8);
      if (off + 24 > buf.byteLength) continue;
      const dms = [];
      for (let k = 0; k < 3; k++) {
        const num = u32(off + k * 8);
        const den = u32(off + k * 8 + 4);
        dms.push(den ? num / den : 0);
      }
      const decimal = dms[0] + dms[1] / 60 + dms[2] / 3600;
      if (tag === 0x0002) lat = decimal; else lon = decimal;
    }
  }

  if (lat != null && lon != null && latRef && lonRef) {
    return {
      lat: latRef === 'S' ? -lat : lat,
      lon: lonRef === 'W' ? -lon : lon,
    };
  }
  return null;
}
