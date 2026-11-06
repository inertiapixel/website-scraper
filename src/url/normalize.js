/**
 * URL parsing and normalization.
 *
 * Page URLs are normalized into a dedupe `key` (fragment removed, host
 * lowercased, default port removed, percent-encoding canonicalized, query
 * parameters filtered/sorted per configuration, optional trailing-slash
 * folding). The `fetchUrl` keeps the form that was first discovered so the
 * server sees a realistic request.
 *
 * Asset URLs keep their query string verbatim (cache busters and signed URLs
 * must not be reordered); only the fragment is removed.
 */
import { UsageError } from '../util/errors.js';
import { globToRegExp } from '../util/glob.js';

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const IGNORED_SCHEMES = /^(?:javascript|mailto|tel|sms|data|blob|about|file|ftp|ws|wss|chrome|intent|whatsapp|skype|callto|geo|market|itms-apps?):/i;

export function normalizePercentEncoding(s) {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

export function normalizeHostname(hostname) {
  let h = String(hostname || '').toLowerCase();
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** True for references that are not navigable HTTP resources (mailto:, javascript:, data:, ...). */
export function isIgnoredReference(raw) {
  const v = String(raw || '').trim();
  return !v || v.startsWith('#') || IGNORED_SCHEMES.test(v);
}

/**
 * Parse `input` (optionally relative to `base`) as an HTTP(S) URL.
 * Returns `{ ok: true, url }` or `{ ok: false, code, message }`.
 */
export function parseHttpUrl(input, base) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, code: 'invalid-url', message: 'Empty URL' };
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return { ok: false, code: 'invalid-url', message: `Invalid URL: ${raw.slice(0, 200)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'unsupported-protocol', message: `Unsupported protocol "${url.protocol}"` };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'credentials-in-url', message: 'URLs containing credentials are not supported' };
  }
  if (!url.hostname) return { ok: false, code: 'invalid-url', message: 'URL has no hostname' };
  const host = normalizeHostname(url.hostname);
  if (host !== url.hostname) url.hostname = host;
  url.hash = '';
  return { ok: true, url };
}

/** Validate the user-supplied starting URL. Throws UsageError with a clear message. */
export function validateStartUrl(input) {
  if (!input || !String(input).trim()) {
    throw new UsageError('A starting URL is required, e.g. "https://example.com".');
  }
  const raw = String(input).trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new UsageError(`Invalid starting URL "${raw}": it must start with http:// or https://`);
  }
  const res = parseHttpUrl(raw);
  if (!res.ok) throw new UsageError(`Invalid starting URL "${raw}": ${res.message}`);
  return res.url;
}

function compileParamMatchers(names) {
  return names.map((n) => {
    if (n.includes('*')) {
      const re = globToRegExp(n.toLowerCase());
      return (name) => re.test(name.toLowerCase());
    }
    const lower = n.toLowerCase();
    return (name) => name.toLowerCase() === lower;
  });
}

function decodeParamName(rawName) {
  try {
    return decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    return rawName;
  }
}

/**
 * Build a page URL normalizer from the crawler configuration.
 * The returned function yields `{ ok, url, key, fetchUrl }` or `{ ok: false, code, message }`.
 */
export function createPageNormalizer(crawlerConfig) {
  const { queryParams, ignoreTrailingSlash } = crawlerConfig;
  const stripMatchers = compileParamMatchers(queryParams.strip);
  const allowMatchers = compileParamMatchers(queryParams.allow);

  function filterQuery(search) {
    if (!search || search === '?') return '';
    if (queryParams.mode === 'drop') return '';
    let parts = search.slice(1).split('&').filter(Boolean).map(normalizePercentEncoding);
    parts = parts.filter((part) => {
      const name = decodeParamName(part.split('=')[0]);
      if (queryParams.mode === 'allowlist') return allowMatchers.some((m) => m(name));
      return !stripMatchers.some((m) => m(name));
    });
    if (queryParams.sort) {
      parts = parts
        .map((p, i) => ({ p, i }))
        .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : a.i - b.i))
        .map((x) => x.p);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  return function normalizePage(input, base) {
    const parsed = parseHttpUrl(input, base);
    if (!parsed.ok) return parsed;
    const url = parsed.url;
    url.pathname = normalizePercentEncoding(url.pathname);
    // Re-parse so any canonicalisation applied by the URL parser is stable.
    const canonical = new URL(url.href);
    const query = filterQuery(canonical.search);
    canonical.search = query;
    const fetchUrl = canonical.href;

    let path = canonical.pathname || '/';
    if (ignoreTrailingSlash && path.length > 1 && path.endsWith('/')) {
      path = path.replace(/\/+$/, '') || '/';
    }
    const key = `${canonical.protocol}//${canonical.host}${path}${query}`;
    return { ok: true, url: canonical, key, fetchUrl };
  };
}

/** Normalize an asset URL: fragment removed, query string kept verbatim. */
export function normalizeAssetUrl(input, base) {
  const parsed = parseHttpUrl(input, base);
  if (!parsed.ok) return parsed;
  const url = parsed.url;
  url.pathname = normalizePercentEncoding(url.pathname);
  const canonical = new URL(url.href);
  return { ok: true, url: canonical, key: canonical.href };
}

/** Remove secret-looking query parameter values from a URL for logging. */
const SECRET_PARAM = /^(?:.*token.*|.*secret.*|.*passw(?:or)?d.*|pwd|auth.*|.*session.*|sid|sig|signature|key|api[-_]?key|access[-_]?key|code|credential.*|x-amz-.*|x-goog-.*|jwt)$/i;

export function redactUrl(input) {
  try {
    const url = new URL(String(input));
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    if (url.search) {
      const parts = url.search.slice(1).split('&').map((part) => {
        const idx = part.indexOf('=');
        const name = decodeParamName(idx === -1 ? part : part.slice(0, idx));
        return idx !== -1 && SECRET_PARAM.test(name) ? `${part.slice(0, idx)}=[REDACTED]` : part;
      });
      url.search = `?${parts.join('&')}`;
    }
    return url.href;
  } catch {
    return String(input);
  }
}
