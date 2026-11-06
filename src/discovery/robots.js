/**
 * robots.txt handling backed by the `robots-parser` package (RFC 9309 style
 * group matching, wildcards, Allow/Disallow precedence, Crawl-delay, Sitemap).
 *
 * Fetch outcomes:
 *   2xx           parse the file
 *   4xx           no restrictions (RFC 9309 section 2.3.1.3)
 *   5xx / network after retries: treat the host as fully disallowed
 *                 (RFC 9309 section 2.3.1.4), recorded with a clear reason
 */
import robotsParser from 'robots-parser';
import { HttpStatusError, describeError, isAbortError } from '../util/errors.js';
import { backoffDelay, sleep } from '../util/time.js';

const MAX_ROBOTS_BYTES = 500 * 1024; // RFC 9309 requires parsing at least 500 KiB

export function productToken(userAgent) {
  const token = String(userAgent).trim().split(/[\s/]/)[0];
  return token || '*';
}

export class RobotsManager {
  constructor({ httpClient, userAgent, enabled, logger, timeoutMs = 15_000, retries = 2, retryBackoffMs = 1000 }) {
    this.http = httpClient;
    this.userAgent = userAgent;
    this.token = productToken(userAgent);
    this.enabled = enabled;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryBackoffMs = retryBackoffMs;
    this.cache = new Map(); // origin -> Promise<entry>
  }

  /** @returns {Promise<{ parser: any|null, disallowAll: boolean, reason?: string, sitemaps: string[] }>} */
  get(origin, signal) {
    if (!this.cache.has(origin)) {
      const p = this.#fetch(origin, signal).catch((err) => {
        this.cache.delete(origin);
        throw err;
      });
      this.cache.set(origin, p);
    }
    return this.cache.get(origin);
  }

  async #fetch(origin, signal) {
    const robotsUrl = `${origin}/robots.txt`;
    let lastError;
    for (let attempt = 1; attempt <= this.retries + 1; attempt++) {
      try {
        const res = await this.http.fetch(robotsUrl, {
          signal,
          timeoutMs: this.timeoutMs,
          maxBytes: MAX_ROBOTS_BYTES * 4,
          accept: 'text/plain,*/*;q=0.5',
          maxRedirects: 5,
          checkRedirect: () => null, // robots.txt redirects may cross hosts (RFC 9309 2.3.1.2)
        });
        if (res.status >= 200 && res.status < 300) {
          const text = res.body.subarray(0, MAX_ROBOTS_BYTES).toString('utf8');
          const parser = robotsParser(robotsUrl, text);
          return { parser, disallowAll: false, sitemaps: parser.getSitemaps() };
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return { parser: null, disallowAll: false, sitemaps: [] };
        }
        lastError = new HttpStatusError(res.status, robotsUrl);
      } catch (err) {
        if (isAbortError(err)) throw err;
        lastError = err;
      }
      if (attempt <= this.retries) await sleep(backoffDelay(this.retryBackoffMs, attempt), signal);
    }
    const reason = `robots.txt unavailable (${describeError(lastError)}); host treated as disallowed`;
    this.logger?.warn(`${robotsUrl}: ${reason}`);
    return { parser: null, disallowAll: true, reason, sitemaps: [] };
  }

  /** @returns {Promise<{ allowed: boolean, reason?: string, crawlDelayMs?: number }>} */
  async check(url, signal) {
    if (!this.enabled) return { allowed: true };
    const entry = await this.get(url.origin, signal);
    if (entry.disallowAll) return { allowed: false, reason: entry.reason };
    if (!entry.parser) return { allowed: true };
    const allowed = entry.parser.isAllowed(url.href, this.token);
    const delay = entry.parser.getCrawlDelay(this.token);
    return {
      allowed: allowed !== false,
      reason: allowed === false ? 'disallowed by robots.txt' : undefined,
      crawlDelayMs: Number.isFinite(delay) ? delay * 1000 : undefined,
    };
  }
}
