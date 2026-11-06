/**
 * Sitemap discovery: robots.txt `Sitemap:` declarations plus `/sitemap.xml`.
 * Supports sitemap index files, gzip-compressed sitemaps and plain-text
 * sitemaps. Sitemap files are only fetched from allowed hosts, and entries are
 * returned as candidate seeds; the crawler applies its normal scope, filter
 * and dedupe rules to every entry.
 */
import zlib from 'node:zlib';
import * as cheerio from 'cheerio';
import { describeError, isAbortError } from '../util/errors.js';
import { redactUrl } from '../url/normalize.js';

const MAX_SITEMAP_BYTES = 50 * 1024 * 1024; // sitemaps.org limit (uncompressed)

function maybeGunzip(body, url, mime) {
  const isGzip = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (!isGzip && !/\.gz$/i.test(new URL(url).pathname) && !/gzip/.test(mime || '')) return body;
  if (!isGzip) return body;
  return zlib.gunzipSync(body, { maxOutputLength: MAX_SITEMAP_BYTES });
}

export function parseSitemap(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) {
    // Plain-text sitemap: one URL per line.
    const urls = trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    return { sitemaps: [], urls };
  }
  const $ = cheerio.load(text, { xml: true });
  const read = (sel) => $(sel).map((_i, el) => $(el).text().trim()).get().filter(Boolean);
  return { sitemaps: read('sitemapindex > sitemap > loc'), urls: read('urlset > url > loc') };
}

/**
 * @returns {Promise<string[]>} candidate page URLs (unfiltered beyond host checks)
 */
export async function discoverSitemapUrls({
  httpClient, startUrl, declared = [], isAllowedHost, maxUrls, maxSitemaps, signal, logger, timeoutMs = 30_000,
}) {
  const queue = [];
  const seen = new Set();
  const push = (u) => {
    let parsed;
    try {
      parsed = new URL(u, startUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(parsed.protocol) || !isAllowedHost(parsed.hostname)) {
      logger?.debug(`Ignoring sitemap outside allowed hosts: ${redactUrl(parsed.href)}`);
      return;
    }
    parsed.hash = '';
    if (seen.has(parsed.href) || seen.size >= maxSitemaps) return;
    seen.add(parsed.href);
    queue.push(parsed.href);
  };
  declared.forEach(push);
  push(new URL('/sitemap.xml', startUrl).href);

  const urls = [];
  while (queue.length && urls.length < maxUrls) {
    const sitemapUrl = queue.shift();
    try {
      const res = await httpClient.fetch(sitemapUrl, {
        signal,
        timeoutMs,
        maxBytes: MAX_SITEMAP_BYTES,
        accept: 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        checkRedirect: (next) => (isAllowedHost(next.hostname) ? null : 'sitemap redirect leaves the allowed hosts'),
      });
      if (res.status === 404 || res.status === 410) {
        logger?.debug(`No sitemap at ${redactUrl(sitemapUrl)} (HTTP ${res.status})`);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        logger?.warn(`Sitemap ${redactUrl(sitemapUrl)} returned HTTP ${res.status}`);
        continue;
      }
      if (/html/.test(res.mime || '')) {
        logger?.debug(`Ignoring ${redactUrl(sitemapUrl)}: served as HTML, not a sitemap`);
        continue;
      }
      const body = maybeGunzip(res.body, sitemapUrl, res.mime);
      const parsed = parseSitemap(body.toString('utf8'));
      parsed.sitemaps.forEach(push);
      for (const u of parsed.urls) {
        if (urls.length >= maxUrls) break;
        urls.push(u);
      }
      logger?.info(`Sitemap ${redactUrl(sitemapUrl)}: ${parsed.urls.length} URLs, ${parsed.sitemaps.length} nested sitemaps`);
    } catch (err) {
      if (isAbortError(err)) throw err;
      logger?.warn(`Sitemap ${redactUrl(sitemapUrl)} could not be processed: ${describeError(err)}`);
    }
  }
  if (urls.length >= maxUrls) logger?.warn(`Sitemap URL limit (${maxUrls}) reached; remaining entries ignored`);
  return urls;
}
