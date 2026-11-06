/**
 * CSS reference discovery and rewriting.
 *
 * A small tokenizer (not regex search) finds `url(...)`, `@import "..."`
 * and `image-set("...")` references while correctly skipping comments and
 * unrelated strings, handling CSS escapes, and tracking whether a reference
 * sits inside an `@font-face` block (so fonts get the right category).
 */
import { categoryFromExtension, extensionOf } from './filetype.js';

const WS = new Set([' ', '\t', '\n', '\r', '\f']);
const isIdentChar = (ch) => ch !== undefined && /[A-Za-z0-9_\-\u0080-￿]/.test(ch);

function readEscape(css, j) {
  const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(j + 1, j + 7));
  if (hex) {
    let end = j + 1 + hex[0].length;
    if (css[end] === '\r' && css[end + 1] === '\n') end += 2;
    else if (WS.has(css[end])) end += 1;
    const cp = parseInt(hex[0], 16);
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return { ch: valid ? String.fromCodePoint(cp) : '�', end };
  }
  if (j + 1 >= css.length) return { ch: '�', end: j + 1 };
  return { ch: css[j + 1], end: j + 2 };
}

function readString(css, i) {
  const quote = css[i];
  let j = i + 1;
  let value = '';
  while (j < css.length) {
    const ch = css[j];
    if (ch === quote) return { end: j + 1, value, valid: true };
    if (ch === '\\') {
      const next = css[j + 1];
      if (next === '\n' || next === '\f') {
        j += 2;
        continue;
      }
      if (next === '\r') {
        j += css[j + 2] === '\n' ? 3 : 2;
        continue;
      }
      const esc = readEscape(css, j);
      value += esc.ch;
      j = esc.end;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === '\f') return { end: j, value, valid: false };
    value += ch;
    j++;
  }
  return { end: css.length, value, valid: false };
}

/** Parse a url( token starting right after "url(". Returns null for invalid tokens. */
function readUrlBody(css, j) {
  const n = css.length;
  while (j < n && WS.has(css[j])) j++;
  if (css[j] === '"' || css[j] === "'") {
    const s = readString(css, j);
    if (!s.valid) return null;
    let k = s.end;
    // Allow (and preserve span over) CSS url modifiers: url("x" modifier)
    let depth = 0;
    while (k < n && !(css[k] === ')' && depth === 0)) {
      if (css[k] === '(') depth++;
      else if (css[k] === ')') depth--;
      k++;
    }
    if (k >= n) return null;
    return { end: k + 1, value: s.value };
  }
  let value = '';
  while (j < n) {
    const ch = css[j];
    if (ch === ')') return { end: j + 1, value };
    if (ch === '\\') {
      const esc = readEscape(css, j);
      value += esc.ch;
      j = esc.end;
      continue;
    }
    if (WS.has(ch)) {
      while (j < n && WS.has(css[j])) j++;
      if (css[j] === ')') return { end: j + 1, value };
      return null;
    }
    if (ch === '"' || ch === "'" || ch === '(') return null;
    value += ch;
    j++;
  }
  return null;
}

/**
 * Find references in a stylesheet.
 * @returns {Array<{start:number,end:number,value:string,type:'url'|'import'|'image-set',form:'url'|'string',context:'import'|'font'|'other'}>}
 */
export function findCssReferences(css) {
  const refs = [];
  const n = css.length;
  let i = 0;
  let depth = 0;
  let fontFaceDepth = -1;
  let fontFacePending = false;
  let importPending = false;
  let parenDepth = 0;
  const imageSetLevels = [];

  const context = () => (importPending ? 'import' : fontFaceDepth >= 0 ? 'font' : 'other');

  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const s = readString(css, i);
      if (s.valid) {
        if (importPending) {
          refs.push({ start: i, end: s.end, value: s.value, type: 'import', form: 'string', context: 'import' });
          importPending = false;
        } else if (imageSetLevels.length && parenDepth === imageSetLevels[imageSetLevels.length - 1]) {
          refs.push({ start: i, end: s.end, value: s.value, type: 'image-set', form: 'string', context: context() });
        }
      }
      i = s.end;
      continue;
    }
    if (ch === '\\') {
      i = readEscape(css, i).end;
      continue;
    }
    if (ch === '{') {
      if (fontFacePending) {
        fontFaceDepth = depth;
        fontFacePending = false;
      }
      importPending = false;
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === fontFaceDepth) fontFaceDepth = -1;
      i++;
      continue;
    }
    if (ch === ';') {
      importPending = false;
      i++;
      continue;
    }
    if (ch === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (ch === ')') {
      if (imageSetLevels.length && parenDepth === imageSetLevels[imageSetLevels.length - 1]) imageSetLevels.pop();
      parenDepth = Math.max(0, parenDepth - 1);
      i++;
      continue;
    }
    if (ch === '@') {
      const m = /^@([A-Za-z-]+)/.exec(css.slice(i, i + 40));
      if (m) {
        const name = m[1].toLowerCase();
        if (name === 'import') importPending = true;
        else if (name === 'font-face') fontFacePending = true;
        i += m[0].length;
        continue;
      }
    }
    if (isIdentChar(ch) && !isIdentChar(css[i - 1])) {
      const m = /^[A-Za-z_\-][A-Za-z0-9_\-]*/.exec(css.slice(i, i + 64));
      if (m && css[i + m[0].length] === '(') {
        const fn = m[0].toLowerCase();
        const open = i + m[0].length;
        if (fn === 'url') {
          const body = readUrlBody(css, open + 1);
          if (body) {
            const type = importPending ? 'import' : 'url';
            refs.push({ start: i, end: body.end, value: body.value.trim(), type, form: 'url', context: context() });
            if (importPending) importPending = false;
            i = body.end;
            continue;
          }
        } else if (fn === 'image-set' || fn === '-webkit-image-set') {
          parenDepth++;
          imageSetLevels.push(parenDepth);
          i = open + 1;
          continue;
        }
        i = open;
        continue;
      }
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return refs;
}

/** Best-guess asset category for a CSS reference. */
export function cssReferenceHint(ref, url) {
  if (ref.type === 'import' || ref.context === 'import') return 'stylesheet';
  const extCat = url ? categoryFromExtension(extensionOf(new URL(url).pathname)) : null;
  if (extCat) return extCat;
  return ref.context === 'font' ? 'font' : 'image';
}

export function escapeCssString(value) {
  return value.replace(/["\\\n\r\f]/g, (ch) => {
    if (ch === '"') return '\\"';
    if (ch === '\\') return '\\\\';
    return `\\${ch.charCodeAt(0).toString(16)} `;
  });
}

/**
 * Rewrite references. `mapFn(ref)` returns the replacement URL string, or
 * null to leave the reference exactly as written.
 */
export function rewriteCss(css, mapFn) {
  const refs = findCssReferences(css);
  if (!refs.length) return css;
  let out = '';
  let last = 0;
  for (const ref of refs) {
    const replacement = mapFn(ref);
    if (replacement == null || replacement === ref.value) continue;
    out += css.slice(last, ref.start);
    out += ref.form === 'url' ? `url("${escapeCssString(replacement)}")` : `"${escapeCssString(replacement)}"`;
    last = ref.end;
  }
  return out + css.slice(last);
}
