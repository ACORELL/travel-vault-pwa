// Minimal JPEG EXIF reader — extracts DateTimeOriginal → "HH:MM:SS" or null

export async function extractTimestamp(file) {
  try {
    return parseJpeg(await file.arrayBuffer());
  } catch {
    return null;
  }
}

function parseJpeg(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return null;

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
  return null;
}

function parseTiff(buf, base) {
  if (base + 8 > buf.byteLength) return null;
  const view = new DataView(buf);
  const le = view.getUint16(base) === 0x4949;
  const u16 = abs => view.getUint16(abs, le);
  const u32 = abs => view.getUint32(abs, le);

  if (u16(base + 2) !== 42) return null;

  const ifd0 = base + u32(base + 4);
  const n0 = u16(ifd0);
  let exifPtr = null;

  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > buf.byteLength) break;
    const tag = u16(e);
    if (tag === 0x9003) return readAscii(buf, base, e, le);
    if (tag === 0x8769) exifPtr = base + u32(e + 8);
  }

  if (exifPtr == null || exifPtr + 2 > buf.byteLength) return null;

  const n1 = u16(exifPtr);
  for (let i = 0; i < n1; i++) {
    const e = exifPtr + 2 + i * 12;
    if (e + 12 > buf.byteLength) break;
    if (u16(e) === 0x9003) return readAscii(buf, base, e, le);
  }
  return null;
}

function readAscii(buf, base, entryAbs, le) {
  const view = new DataView(buf);
  const u32 = abs => view.getUint32(abs, le);
  const count = u32(entryAbs + 4);
  const start = base + u32(entryAbs + 8); // DateTimeOriginal is always > 4 bytes, so offset form
  if (start + count > buf.byteLength) return null;
  const str = String.fromCharCode(...new Uint8Array(buf, start, Math.min(count, 24))).replace(/\0.*$/, '');
  const m = str.match(/\d{4}:\d{2}:\d{2} (\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}
