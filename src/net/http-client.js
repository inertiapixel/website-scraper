/**
 * Minimal, safety-focused HTTP(S) client built on node:http/node:https.
 *
 *  - Every DNS answer is checked against private/loopback/link-local ranges
 *    (unless network.allowPrivateNetworks is enabled), at connection time,
 *    so redirects and DNS tricks cannot reach internal services.
 *  - Redirects are followed manually; each hop is validated by the caller's
 *    `checkRedirect` so a redirect can never escape the allowed scope.
 *  - Bodies are streamed. Size limits are enforced on the decoded byte count
 *    while streaming, independent of Content-Length.
 *  - A single deadline covers connect, redirects, headers and body.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortedError, BlockedRequestError, HttpStatusError, RedirectScopeError, SizeLimitError,
  TimeoutError, TooManyRedirectsError, TruncatedResponseError,
} from '../util/errors.js';
import { hostnameForLookup, isBlockedAddress } from './ip.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function parseRetryAfter(value, capMs = 120_000) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(capMs, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(capMs, Math.max(0, date - Date.now()));
  return undefined;
}

export function parseContentLength(headers) {
  const raw = headers['content-length'];
  if (raw === undefined) return null;
  const n = Number(String(raw).trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function parseContentType(headers) {
  const raw = String(headers['content-type'] || '');
  const [type, ...params] = raw.split(';');
  const mime = type.trim().toLowerCase();
  let charset = null;
  for (const p of params) {
    const m = p.trim().match(/^charset\s*=\s*"?([^";]+)"?$/i);
    if (m) charset = m[1].trim().toLowerCase();
  }
  return { mime: mime || null, charset };
}

function linkedController(parentSignal, timeoutMs) {
  const ctl = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => ctl.abort(new TimeoutError(`Request timed out after ${timeoutMs} ms`)), timeoutMs)
    : null;
  const onAbort = () => ctl.abort(new AbortedError());
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
    /** Replace low-level abort errors with the reason (timeout vs. cancellation). */
    mapError(err) {
      return ctl.signal.aborted && ctl.signal.reason ? ctl.signal.reason : err;
    },
  };
}

function decodeBody(res) {
  const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return { streams: [res], encoded: false };
  if (enc === 'gzip' || enc === 'x-gzip') return { streams: [res, zlib.createGunzip()], encoded: true };
  if (enc === 'deflate') return { streams: [res, zlib.createInflate()], encoded: true };
  if (enc === 'br') return { streams: [res, zlib.createBrotliDecompress()], encoded: true };
  throw new Error(`Unsupported Content-Encoding "${enc}"`);
}

export class HttpClient {
  /**
   * @param {object} opts
   * @param {string} opts.userAgent
   * @param {boolean} [opts.allowPrivateNetworks]
   * @param {(hostname: string) => Array<{address: string, family: number}>|null} [opts.resolveOverride]
   *        test hook: static host -> address mapping (results are still SSRF-checked)
   * @param {(address: string) => boolean} [opts.isBlockedAddress] test hook: address policy
   */
  constructor({ userAgent, allowPrivateNetworks = false, resolveOverride = null, isBlockedAddress: blockedFn = isBlockedAddress }) {
    this.userAgent = userAgent;
    this.allowPrivateNetworks = allowPrivateNetworks;
    this.resolveOverride = resolveOverride;
    this.isBlocked = blockedFn;
    this.lookup = this.#createLookup();
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16, timeout: 60_000 });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 60_000 });
  }

  close() {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  #createLookup() {
    return (hostname, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const family = options?.family === 4 || options?.family === 6 ? options.family : 0;
      const done = (err, addresses) => {
        if (err) return callback(err);
        const blocked = this.allowPrivateNetworks ? null : addresses.find((a) => this.isBlocked(a.address));
        if (blocked) {
          return callback(new BlockedRequestError(
            `Refusing to connect to "${hostname}" (${blocked.address}): private, loopback, link-local or reserved address. ` +
            'Set network.allowPrivateNetworks only for trusted local testing.',
          ));
        }
        const list = family ? addresses.filter((a) => a.family === family) : addresses;
        if (!list.length) {
          const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
          e.code = 'ENOTFOUND';
          return callback(e);
        }
        if (options?.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
      };
      const override = this.resolveOverride?.(hostname);
      if (override) return process.nextTick(done, null, override);
      dns.lookup(hostname, { all: true, family }, done);
    };
  }

  /** Resolve a hostname and verify it is safe to contact. Used by the browser request guard. */
  async assertHostAllowed(hostname) {
    const host = hostnameForLookup(hostname);
    if (net.isIP(host)) {
      if (!this.allowPrivateNetworks && this.isBlocked(host)) {
        throw new BlockedRequestError(`Refusing to contact private or reserved address ${host}`);
      }
      return;
    }
    await new Promise((resolve, reject) => {
      this.lookup(host, { all: true }, (err) => (err ? reject(err) : resolve()));
    });
  }

  #assertUrl(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedRequestError(`Unsupported protocol "${url.protocol}"`);
    }
    const host = hostnameForLookup(url.hostname);
    if (net.isIP(host) && !this.allowPrivateNetworks && this.isBlocked(host)) {
      throw new BlockedRequestError(
        `Refusing to contact private or reserved address ${host}. Set network.allowPrivateNetworks only for trusted local testing.`,
      );
    }
  }

  #requestOnce(url, headers, signal) {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:';
      const req = (isHttps ? https : http).request(url, {
        method: 'GET',
        headers,
        lookup: this.lookup,
        agent: isHttps ? this.httpsAgent : this.httpAgent,
        signal,
      });
      req.once('response', resolve);
      req.once('error', reject);
      req.end();
    });
  }

  /**
   * Open a URL, following redirects. Resolves with the final response whose
   * body has not been consumed. Caller must consume or destroy `res`.
   */
  async #open(startUrl, { signal, accept, maxRedirects = 10, checkRedirect }) {
    let url = new URL(startUrl);
    const redirects = [];
    const headers = {
      'user-agent': this.userAgent,
      accept: accept || '*/*',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9',
    };
    for (let hop = 0; ; hop++) {
      this.#assertUrl(url);
      const res = await this.#requestOnce(url, headers, signal);
      if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
        res.resume();
        if (hop >= maxRedirects) throw new TooManyRedirectsError(`More than ${maxRedirects} redirects`);
        let next;
        try {
          next = new URL(res.headers.location, url);
        } catch {
          throw new RedirectScopeError(`Invalid redirect location "${String(res.headers.location).slice(0, 200)}"`);
        }
        next.hash = '';
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new RedirectScopeError(`Redirect to unsupported protocol "${next.protocol}"`, { location: next.href });
        }
        const reason = checkRedirect ? checkRedirect(next) : null;
        if (reason) throw new RedirectScopeError(`Redirect to ${next.href} refused: ${reason}`, { location: next.href });
        redirects.push({ from: url.href, to: next.href, status: res.statusCode });
        url = next;
        continue;
      }
      return { res, url, redirects };
    }
  }

  /**
   * Fetch a resource into memory with a hard size limit.
   * `onHeaders(info)` may return `{ stop: true }` to skip reading the body.
   */
  async fetch(url, { signal, timeoutMs = 30_000, maxBytes = null, accept, maxRedirects, checkRedirect, onHeaders } = {}) {
    const ctl = linkedController(signal, timeoutMs);
    let res;
    let overflow = null;
    try {
      const opened = await this.#open(url, { signal: ctl.signal, accept, maxRedirects, checkRedirect });
      res = opened.res;
      const info = {
        status: res.statusCode,
        headers: res.headers,
        finalUrl: opened.url.href,
        redirects: opened.redirects,
        declaredLength: parseContentLength(res.headers),
        ...parseContentType(res.headers),
      };
      if (onHeaders) {
        const decision = await onHeaders(info);
        if (decision?.stop) {
          res.destroy();
          return { ...info, body: null, stopped: true };
        }
      }
      if (maxBytes != null && info.declaredLength != null && info.declaredLength > maxBytes) {
        res.destroy();
        throw new SizeLimitError(`Content-Length ${info.declaredLength} exceeds limit of ${maxBytes} bytes`, {
          limit: maxBytes, declared: info.declaredLength,
        });
      }
      const { streams, encoded } = decodeBody(res);
      const chunks = [];
      let total = 0;
      await pipeline(
        ...streams,
        async function collect(source) {
          for await (const chunk of source) {
            total += chunk.length;
            if (maxBytes != null && total > maxBytes) {
              // Kept aside: pipeline() reports a sink error as a generic AbortError.
              overflow = new SizeLimitError(`Response exceeded limit of ${maxBytes} bytes`, { limit: maxBytes, received: total });
              throw overflow;
            }
            chunks.push(chunk);
          }
        },
        { signal: ctl.signal },
      );
      if (!encoded && info.declaredLength != null && total !== info.declaredLength) {
        throw new TruncatedResponseError(`Received ${total} of ${info.declaredLength} declared bytes`);
      }
      return { ...info, body: Buffer.concat(chunks), stopped: false };
    } catch (err) {
      res?.destroy();
      throw overflow ?? ctl.mapError(err);
    } finally {
      ctl.dispose();
    }
  }

  /**
   * Stream a resource to `filePath` (created exclusively). Partial files are
   * removed on any failure, including size-limit violations.
   *
   * `onHeaders(info)` runs before any body byte is written and may throw a
   * SkipError. `onFirstBytes(buffer, info)` receives up to the first 64 decoded
   * bytes (for content sniffing) and may also throw.
   */
  async download(url, filePath, { signal, timeoutMs = 30_000, maxBytes = null, accept, maxRedirects, checkRedirect, onHeaders, onFirstBytes } = {}) {
    const ctl = linkedController(signal, timeoutMs);
    let res;
    let created = false;
    try {
      const opened = await this.#open(url, { signal: ctl.signal, accept, maxRedirects, checkRedirect });
      res = opened.res;
      const info = {
        status: res.statusCode,
        headers: res.headers,
        finalUrl: opened.url.href,
        redirects: opened.redirects,
        declaredLength: parseContentLength(res.headers),
        ...parseContentType(res.headers),
      };
      if (info.status < 200 || info.status >= 300) {
        res.resume();
        throw new HttpStatusError(info.status, info.finalUrl, { retryAfterMs: parseRetryAfter(res.headers['retry-after']) });
      }
      if (maxBytes != null && info.declaredLength != null && info.declaredLength > maxBytes) {
        res.destroy();
        throw new SizeLimitError(`Content-Length ${info.declaredLength} exceeds limit of ${maxBytes} bytes`, {
          limit: maxBytes, declared: info.declaredLength,
        });
      }
      if (onHeaders) await onHeaders(info);

      const { streams, encoded } = decodeBody(res);
      let total = 0;
      let head = Buffer.alloc(0);
      let sniffed = !onFirstBytes;
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          total += chunk.length;
          if (maxBytes != null && total > maxBytes) {
            cb(new SizeLimitError(`Download exceeded limit of ${maxBytes} bytes while streaming`, { limit: maxBytes, received: total }));
            return;
          }
          if (!sniffed) {
            head = Buffer.concat([head, chunk]);
            if (head.length >= 64) {
              sniffed = true;
              try {
                onFirstBytes(head.subarray(0, 64), info);
              } catch (err) {
                cb(err);
                return;
              }
            }
          }
          cb(null, chunk);
        },
        flush(cb) {
          if (!sniffed) {
            sniffed = true;
            try {
              onFirstBytes(head, info);
            } catch (err) {
              cb(err);
              return;
            }
          }
          cb();
        },
      });
      const out = fs.createWriteStream(filePath, { flags: 'wx' });
      out.once('open', () => {
        created = true;
      });
      await pipeline(...streams, limiter, out, { signal: ctl.signal });
      if (!encoded && info.declaredLength != null && total !== info.declaredLength) {
        throw new TruncatedResponseError(`Received ${total} of ${info.declaredLength} declared bytes`);
      }
      return { ...info, bytes: total };
    } catch (err) {
      res?.destroy();
      if (created) await fsp.rm(filePath, { force: true }).catch(() => {});
      throw ctl.mapError(err);
    } finally {
      ctl.dispose();
    }
  }
}
