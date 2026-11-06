/**
 * File type detection from URL extension, MIME type and magic bytes.
 * Extensions alone are never trusted: the response MIME type and, for
 * generic or missing types, the first bytes of the body are also checked.
 */
import { extname } from 'node:path/posix';

const EXT = {
  // stylesheets & scripts
  '.css': ['stylesheet', 'text/css'],
  '.js': ['script', 'text/javascript'], '.mjs': ['script', 'text/javascript'], '.cjs': ['script', 'text/javascript'],
  // images
  '.png': ['image', 'image/png'], '.apng': ['image', 'image/apng'], '.jpg': ['image', 'image/jpeg'],
  '.jpeg': ['image', 'image/jpeg'], '.jpe': ['image', 'image/jpeg'], '.jfif': ['image', 'image/jpeg'],
  '.gif': ['image', 'image/gif'], '.webp': ['image', 'image/webp'], '.avif': ['image', 'image/avif'],
  '.svg': ['image', 'image/svg+xml'], '.svgz': ['image', 'image/svg+xml'], '.ico': ['image', 'image/x-icon'],
  '.cur': ['image', 'image/x-icon'], '.bmp': ['image', 'image/bmp'], '.tif': ['image', 'image/tiff'],
  '.tiff': ['image', 'image/tiff'], '.jxl': ['image', 'image/jxl'], '.heic': ['image', 'image/heic'],
  // fonts
  '.woff': ['font', 'font/woff'], '.woff2': ['font', 'font/woff2'], '.ttf': ['font', 'font/ttf'],
  '.otf': ['font', 'font/otf'], '.eot': ['font', 'application/vnd.ms-fontobject'],
  // video
  '.mp4': ['video', 'video/mp4'], '.m4v': ['video', 'video/x-m4v'], '.mov': ['video', 'video/quicktime'],
  '.avi': ['video', 'video/x-msvideo'], '.mkv': ['video', 'video/x-matroska'], '.webm': ['video', 'video/webm'],
  '.mpeg': ['video', 'video/mpeg'], '.mpg': ['video', 'video/mpeg'], '.ogv': ['video', 'video/ogg'],
  '.wmv': ['video', 'video/x-ms-wmv'], '.flv': ['video', 'video/x-flv'], '.3gp': ['video', 'video/3gpp'],
  '.m3u8': ['video', 'application/vnd.apple.mpegurl'],
  // audio
  '.mp3': ['audio', 'audio/mpeg'], '.wav': ['audio', 'audio/wav'], '.ogg': ['audio', 'audio/ogg'],
  '.oga': ['audio', 'audio/ogg'], '.m4a': ['audio', 'audio/mp4'], '.aac': ['audio', 'audio/aac'],
  '.flac': ['audio', 'audio/flac'], '.wma': ['audio', 'audio/x-ms-wma'], '.opus': ['audio', 'audio/opus'],
  '.weba': ['audio', 'audio/webm'], '.aiff': ['audio', 'audio/aiff'], '.mid': ['audio', 'audio/midi'],
  // documents
  '.pdf': ['document', 'application/pdf'], '.doc': ['document', 'application/msword'],
  '.docx': ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.xls': ['document', 'application/vnd.ms-excel'],
  '.xlsx': ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.ppt': ['document', 'application/vnd.ms-powerpoint'],
  '.pptx': ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.odt': ['document', 'application/vnd.oasis.opendocument.text'], '.rtf': ['document', 'application/rtf'],
  '.txt': ['document', 'text/plain'], '.csv': ['document', 'text/csv'], '.md': ['document', 'text/markdown'],
  // data
  '.json': ['data', 'application/json'], '.webmanifest': ['data', 'application/manifest+json'],
  '.xml': ['data', 'application/xml'], '.map': ['data', 'application/json'], '.wasm': ['data', 'application/wasm'],
  '.vtt': ['data', 'text/vtt'], '.srt': ['data', 'text/plain'], '.rss': ['data', 'application/rss+xml'],
  '.atom': ['data', 'application/atom+xml'],
  // archives & binaries
  '.zip': ['other', 'application/zip'], '.gz': ['other', 'application/gzip'], '.tgz': ['other', 'application/gzip'],
  '.rar': ['other', 'application/vnd.rar'], '.7z': ['other', 'application/x-7z-compressed'],
  '.tar': ['other', 'application/x-tar'], '.dmg': ['other', 'application/x-apple-diskimage'],
  '.exe': ['other', 'application/octet-stream'], '.apk': ['other', 'application/vnd.android.package-archive'],
  '.swf': ['other', 'application/x-shockwave-flash'],
};

const PAGE_EXTENSIONS = new Set([
  '', '.html', '.htm', '.xhtml', '.shtml', '.php', '.phtml', '.asp', '.aspx', '.jsp', '.jspx', '.cfm', '.cgi', '.pl',
]);

const MIME_EXTS = {};
for (const [ext, [, mime]] of Object.entries(EXT)) (MIME_EXTS[mime] ||= []).push(ext);
Object.assign(MIME_EXTS, {
  'application/javascript': ['.js', '.mjs', '.cjs'], 'application/x-javascript': ['.js'], 'text/ecmascript': ['.js'],
  'application/ecmascript': ['.js'], 'image/jpg': ['.jpg', '.jpeg'], 'image/pjpeg': ['.jpg', '.jpeg'],
  'image/vnd.microsoft.icon': ['.ico', '.cur'], 'image/x-png': ['.png'], 'application/font-woff': ['.woff'],
  'application/x-font-woff': ['.woff'], 'application/font-woff2': ['.woff2'], 'application/x-font-ttf': ['.ttf'],
  'application/x-font-truetype': ['.ttf'], 'application/x-font-otf': ['.otf'], 'application/font-sfnt': ['.ttf', '.otf'],
  'font/sfnt': ['.ttf', '.otf'], 'font/collection': ['.ttc'], 'application/vnd.ms-fontobject': ['.eot'],
  'text/xml': ['.xml', '.rss', '.atom', '.svg'], 'application/json': ['.json', '.map', '.webmanifest'],
  'application/manifest+json': ['.webmanifest', '.json'], 'application/ld+json': ['.json', '.jsonld'],
  'text/html': ['.html', '.htm'], 'application/xhtml+xml': ['.xhtml', '.html'],
});

/** Generic types that say nothing about the content; sniffing decides. */
const GENERIC_MIMES = new Set([
  '', 'application/octet-stream', 'binary/octet-stream', 'application/unknown', 'application/x-unknown',
  'application/download', 'application/force-download', 'unknown/unknown',
]);

export function extensionOf(pathname) {
  let p = String(pathname || '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  const ext = extname(p.split('/').pop() || '').toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : '';
}

export function categoryFromExtension(ext) {
  if (EXT[ext]) return EXT[ext][0];
  return null;
}

export function mimeFromExtension(ext) {
  return EXT[ext]?.[1] ?? null;
}

export function isGenericMime(mime) {
  return GENERIC_MIMES.has(String(mime || '').toLowerCase());
}

export function isHtmlMime(mime) {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

export function categoryFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (isGenericMime(m)) return null;
  if (isHtmlMime(m)) return 'html';
  if (m === 'text/css') return 'stylesheet';
  if (/^(?:text|application)\/(?:x-)?(?:java|ecma)script$/.test(m) || m === 'text/jscript' || m === 'application/x-javascript') return 'script';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('font/') || /^application\/(?:x-)?font-|^application\/vnd\.ms-fontobject$/.test(m)) return 'font';
  if (m.startsWith('video/') || m === 'application/vnd.apple.mpegurl' || m === 'application/x-mpegurl' || m === 'application/dash+xml') return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (/^application\/(?:pdf|msword|rtf|vnd\.ms-|vnd\.openxmlformats|vnd\.oasis)/.test(m) || m === 'text/plain' || m === 'text/csv' || m === 'text/markdown') return 'document';
  if (/json|xml|^application\/wasm$|^text\/vtt$/.test(m)) return 'data';
  return 'other';
}

/** Match a MIME type against patterns like "video/*" or "audio/mpeg". */
export function mimeMatches(mime, patterns) {
  const m = String(mime || '').toLowerCase();
  if (!m) return false;
  return patterns.some((p) => (p.endsWith('/*') ? m.startsWith(p.slice(0, -1)) : m === p));
}

const ISO_IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const ISO_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);

/**
 * Identify content from its first bytes. Returns `{ mime, category }` or null.
 * `strict` enables weaker signatures (MP3 frame sync, ADTS AAC) that are only
 * safe to use when the declared type is generic.
 */
export function sniff(buf, { strict = false } = {}) {
  if (!buf || buf.length < 4) return null;
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  const b = buf;
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return { mime: 'image/png', category: 'image' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', category: 'image' };
  if (ascii(0, 4) === 'GIF8') return { mime: 'image/gif', category: 'image' };
  if (ascii(0, 4) === 'RIFF' && buf.length >= 12) {
    const kind = ascii(8, 12);
    if (kind === 'WEBP') return { mime: 'image/webp', category: 'image' };
    if (kind === 'WAVE') return { mime: 'audio/wav', category: 'audio' };
    if (kind === 'AVI ') return { mime: 'video/x-msvideo', category: 'video' };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { mime: 'image/x-icon', category: 'image' };
  if (ascii(0, 4) === 'wOFF') return { mime: 'font/woff', category: 'font' };
  if (ascii(0, 4) === 'wOF2') return { mime: 'font/woff2', category: 'font' };
  if (ascii(0, 4) === 'OTTO') return { mime: 'font/otf', category: 'font' };
  if (ascii(0, 4) === '%PDF') return { mime: 'application/pdf', category: 'document' };
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (ISO_IMAGE_BRANDS.has(brand)) return { mime: 'image/avif', category: 'image' };
    if (ISO_AUDIO_BRANDS.has(brand)) return { mime: 'audio/mp4', category: 'audio' };
    return { mime: brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4', category: 'video' };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', category: 'video' };
  if (ascii(0, 3) === 'FLV') return { mime: 'video/x-flv', category: 'video' };
  if (b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75) return { mime: 'video/x-ms-asf', category: 'video' };
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && (b[3] === 0xba || b[3] === 0xb3)) return { mime: 'video/mpeg', category: 'video' };
  if (ascii(0, 4) === 'OggS') return { mime: 'audio/ogg', category: 'audio' };
  if (ascii(0, 4) === 'fLaC') return { mime: 'audio/flac', category: 'audio' };
  if (ascii(0, 3) === 'ID3') return { mime: 'audio/mpeg', category: 'audio' };
  if (ascii(0, 4) === 'FORM' && buf.length >= 12 && /^AIF[FC]$/.test(ascii(8, 12))) return { mime: 'audio/aiff', category: 'audio' };
  if (ascii(0, 4) === 'MThd') return { mime: 'audio/midi', category: 'audio' };
  if (strict && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync (MP3) or ADTS AAC
    return (b[1] & 0x06) === 0 ? { mime: 'audio/aac', category: 'audio' } : { mime: 'audio/mpeg', category: 'audio' };
  }
  const text = ascii(0, Math.min(buf.length, 64)).trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return { mime: 'image/svg+xml', category: 'image' };
  return null;
}

/** Canonical extension for a MIME type (".bin" when unknown). */
export function preferredExtension(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/svg+xml') return '.svg';
  return MIME_EXTS[m]?.[0] ?? null;
}

/** Whether a URL's extension is plausible for the served MIME type. */
export function extensionCompatible(ext, mime) {
  const m = String(mime || '').toLowerCase();
  if (!ext) return false;
  if (isGenericMime(m) || m === 'text/plain') return true;
  const list = MIME_EXTS[m];
  if (!list) return true; // unknown MIME: keep the original extension
  return list.includes(ext);
}

/** Whether a link should be crawled as a page (vs. downloaded as an asset), judged by extension. */
export function looksLikePage(url) {
  const ext = extensionOf(url.pathname);
  return PAGE_EXTENSIONS.has(ext) || !EXT[ext];
}
