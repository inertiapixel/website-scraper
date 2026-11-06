/**
 * Mapping of URLs to local file paths inside a job directory.
 *
 * Layout (preserveStructure = true):
 *   index.html, about/index.html, blog/post.html     pages on the starting host
 *   _sites/<host>/...                                 pages on other allowed hosts
 *   _assets/<host>/<url path>                         downloaded assets
 *   _collisions/<hash>.<ext>                          rare fallbacks for path conflicts
 *
 * Query variants get a deterministic hash suffix so they never overwrite
 * each other. Every segment is sanitized for Windows/macOS/Linux and the
 * final path is verified to stay inside the job directory.
 */
import path from 'node:path';
import { shortHash } from '../util/hash.js';
import { extensionOf, extensionCompatible, preferredExtension } from '../content/filetype.js';

export const RESERVED_ROOT_NAMES = new Set(['_assets', '_sites', '_collisions', '_pages', '.tmp', 'crawl-report.json']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const PAGE_FILE_EXT = /\.(?:html?|xhtml)$/i;
const MAX_SEGMENT_BYTES = 120;
const MAX_REL_PATH = 220;

const CATEGORY_DIRS = {
  stylesheet: 'css', script: 'js', image: 'images', font: 'fonts', document: 'documents',
  data: 'data', video: 'media', audio: 'media', other: 'other',
};

function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function truncateBytes(s, maxBytes) {
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

/** Make one path segment safe on all major filesystems. Never returns "", "." or "..". */
export function sanitizeSegment(raw) {
  let s = String(raw).normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f<>:"\\|?*/]/g, '_');
  s = s.replace(/[. ]+$/, (m) => '_'.repeat(m.length));
  if (!s) s = '_';
  if (/^\.+$/.test(s)) s = s.replace(/\./g, '_');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (Buffer.byteLength(s) > MAX_SEGMENT_BYTES) {
    const ext = path.extname(s).slice(0, 16);
    const stem = truncateBytes(s.slice(0, s.length - ext.length), MAX_SEGMENT_BYTES - ext.length - 9);
    s = `${stem}-${shortHash(raw)}${ext}`;
  }
  return s;
}

export function hostDirName(url) {
  const port = url.port ? `_${url.port}` : '';
  return sanitizeSegment(`${url.hostname.replace(/^\[|\]$/g, '')}${port}`.toLowerCase());
}

function pathSegments(pathname) {
  return pathname.split('/').filter((s) => s !== '').map((s) => sanitizeSegment(decodeSegment(s)));
}

function querySuffix(search) {
  if (!search || search === '?') return '';
  const slug = sanitizeSegment(decodeSegment(search.slice(1)))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `.q-${slug ? `${slug}-` : ''}${shortHash(search)}`;
}

function withSuffix(fileName, suffix) {
  if (!suffix) return fileName;
  const ext = path.extname(fileName);
  return `${fileName.slice(0, fileName.length - ext.length)}${suffix}${ext}`;
}

function finalize(rel, url, ext) {
  if (rel.length > MAX_REL_PATH) return `_collisions/${shortHash(url.href, 16)}${ext}`;
  return rel;
}

/**
 * Local path of a page relative to the job root.
 * @param {URL} url final (or normalized) page URL
 * @param {{ primaryHost: string, primaryPort: string, preserveStructure: boolean, isStart?: boolean }} opts
 */
export function pageLocalPath(url, { primaryHost, primaryPort = '', preserveStructure = true, isStart = false }) {
  const onPrimary = url.hostname === primaryHost && url.port === primaryPort;
  if (!preserveStructure) {
    if (isStart) return 'index.html';
    const name = sanitizeSegment(`${url.hostname}${url.pathname}`.replace(/\/+$/, '').replace(/[/.]+/g, '-')).slice(0, 60);
    return `_pages/${name}-${shortHash(url.href)}.html`;
  }
  const segs = pathSegments(url.pathname);
  let file = 'index.html';
  if (segs.length && PAGE_FILE_EXT.test(segs[segs.length - 1]) && !url.pathname.endsWith('/')) {
    file = segs.pop();
  }
  file = withSuffix(file, querySuffix(url.search));
  const prefix = onPrimary ? [] : ['_sites', hostDirName(url)];
  const parts = [...prefix, ...segs, file];
  if (onPrimary && RESERVED_ROOT_NAMES.has(parts[0])) parts[0] = `_${parts[0]}`;
  return finalize(parts.join('/'), url, '.html');
}

/**
 * Local path of an asset relative to the job root. The extension is fixed up
 * from the MIME type when the URL has none or a misleading one.
 */
export function assetLocalPath(url, { mime = null, category = 'other', preserveStructure = true }) {
  const segs = pathSegments(url.pathname);
  let file = url.pathname.endsWith('/') || !segs.length ? 'index' : segs.pop();
  const ext = extensionOf(file);
  const preferred = preferredExtension(mime);
  if (!ext || (mime && !extensionCompatible(ext, mime))) {
    file += preferred || (ext ? '' : '.bin');
  }
  const finalExt = path.extname(file) || '.bin';
  if (!preserveStructure) {
    const stem = sanitizeSegment(file.slice(0, file.length - path.extname(file).length)).slice(0, 60);
    return `_assets/${hostDirName(url)}/${CATEGORY_DIRS[category] || 'other'}/${stem}-${shortHash(url.href)}${finalExt}`;
  }
  file = withSuffix(file, querySuffix(url.search));
  return finalize(['_assets', hostDirName(url), ...segs, file].join('/'), url, finalExt);
}

/** Alternate path used when the preferred one is already taken by another URL. */
export function alternatePath(rel, ownerKey) {
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const next = withSuffix(base, `-${shortHash(ownerKey)}`);
  return dir === '.' ? next : `${dir}/${next}`;
}

export function collisionPath(rel, ownerKey) {
  return `_collisions/${shortHash(ownerKey, 16)}${path.posix.extname(rel) || '.bin'}`;
}

/** Case- and normalization-insensitive key (macOS/Windows filesystems). */
export function pathKey(rel) {
  return rel.normalize('NFC').toLowerCase();
}

/** Resolve a relative path inside `root`, refusing anything that escapes it. */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Unsafe output path: ${JSON.stringify(rel)}`);
  }
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, rel);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Output path escapes the job directory: ${JSON.stringify(rel)}`);
  }
  return full;
}
