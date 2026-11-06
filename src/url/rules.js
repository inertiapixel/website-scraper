/**
 * Path include/exclude rules and crawl-trap heuristics for page URLs.
 */
import { compilePatternList } from '../util/glob.js';

function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** URL without its query string; used to limit query variants per path. */
export function pathKeyOf(url) {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/**
 * Structural pattern of a URL path: digit runs are replaced so that
 * `/calendar/2024/01` and `/calendar/2031/12` share one pattern.
 */
export function patternOf(url) {
  const path = url.pathname.replace(/\d+/g, '{n}');
  return `${url.host}${path}`;
}

export function createPageRules(crawler) {
  const include = crawler.includePaths.length ? compilePatternList(crawler.includePaths) : null;
  const exclude = crawler.excludePaths.length ? compilePatternList(crawler.excludePaths) : null;
  const trap = crawler.trapProtection;

  /**
   * Static checks that depend only on the URL itself.
   * Returns null when allowed, otherwise `{ code, message }`.
   */
  function check(url, { isStart = false } = {}) {
    const href = url.href;
    if (href.length > trap.maxUrlLength) {
      return { code: 'trap-url-length', message: `URL longer than ${trap.maxUrlLength} characters` };
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length > trap.maxPathSegments) {
      return { code: 'trap-path-depth', message: `more than ${trap.maxPathSegments} path segments` };
    }
    const counts = new Map();
    for (const seg of segments) {
      const s = decodeSegment(seg).toLowerCase();
      const c = (counts.get(s) || 0) + 1;
      if (c > trap.maxRepeatedSegments) {
        return { code: 'trap-repeated-segment', message: `path segment "${s.slice(0, 40)}" repeats more than ${trap.maxRepeatedSegments} times` };
      }
      counts.set(s, c);
    }
    const pathAndQuery = `${url.pathname}${url.search}`;
    if (exclude && (exclude(url.pathname) || exclude(pathAndQuery))) {
      return { code: 'excluded-path', message: 'matches crawler.excludePaths' };
    }
    if (include && !isStart && !(include(url.pathname) || include(pathAndQuery))) {
      return { code: 'not-included-path', message: 'does not match crawler.includePaths' };
    }
    return null;
  }

  return { check };
}
