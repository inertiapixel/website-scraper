/**
 * Character-encoding helpers. Saved HTML is always written as UTF-8 (the
 * rewriter replaces any charset declaration). Stylesheets keep their bytes:
 * valid UTF-8 is decoded as UTF-8, anything else as latin1 (byte-preserving).
 */
function bomLabel(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return null;
}

export function sniffHtmlCharset(buf) {
  const head = buf.subarray(0, 4096).toString('latin1');
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)/i.exec(head);
  return m ? m[1].toLowerCase() : null;
}

export function decodeHtml(buf, headerCharset) {
  const label = bomLabel(buf) || headerCharset || sniffHtmlCharset(buf) || 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export function decodeCssBuffer(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8' };
  } catch {
    return { text: buf.toString('latin1'), encoding: 'latin1' };
  }
}

export function looksLikeHtml(buf) {
  const s = buf.subarray(0, 2048).toString('latin1').trimStart().toLowerCase();
  return s.startsWith('<!doctype html') || s.startsWith('<html') || /<(?:head|body|title|meta|div|p|a)\b/.test(s);
}
