/**
 * srcset parsing/serialization following the HTML "parse a srcset attribute"
 * algorithm closely enough for rewriting: URLs are whitespace-delimited (so
 * data: URLs containing commas survive) and descriptors run until a comma
 * outside parentheses.
 */
const isWs = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

export function parseSrcset(value) {
  const s = String(value || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (isWs(s[i]) || s[i] === ',')) i++;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isWs(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const dStart = i;
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) break;
        i++;
      }
      descriptor = s.slice(dStart, i).trim();
      i++;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

export function serializeSrcset(candidates) {
  return candidates.map((c) => (c.descriptor ? `${c.url} ${c.descriptor}` : c.url)).join(', ');
}
