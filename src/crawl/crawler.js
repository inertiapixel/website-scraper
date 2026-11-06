/**
 * Crawl orchestrator for one job run.
 *
 * Work items live in SQLite (pages: QUEUED/PROCESSING/..., assets:
 * PENDING/DOWNLOADING/...). Bounded pools of page and asset workers claim
 * items atomically, process them and record the outcome, so the frontier is
 * durable at every step. A stop/pause request lets in-flight items finish
 * for a grace period, then aborts them; aborted items return to the queue.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpClient } from '../net/http-client.js';
import { HostRateLimiter } from '../net/rate-limiter.js';
import { RobotsManager } from '../discovery/robots.js';
import { discoverSitemapUrls } from '../discovery/sitemap.js';
import { BrowserRenderer } from '../render/browser.js';
import { createScope } from '../url/scope.js';
import { createPageRules, pathKeyOf, patternOf } from '../url/rules.js';
import { createPageNormalizer, normalizeAssetUrl, isIgnoredReference, redactUrl } from '../url/normalize.js';
import { extractReferences } from '../content/html.js';
import { findCssReferences, cssReferenceHint } from '../content/css.js';
import { decodeHtml, decodeCssBuffer, looksLikeHtml } from '../content/encoding.js';
import { categoryFromExtension, categoryFromMime, extensionOf, isHtmlMime, looksLikePage } from '../content/filetype.js';
import { pageLocalPath, assetLocalPath, safeJoin } from '../output/paths.js';
import { createAssetFilter } from './asset-filter.js';
import { PageStatus, AssetStatus } from '../jobs/states.js';
import {
  AbortedError, BlockedRequestError, HttpStatusError, RedirectScopeError, SizeLimitError, SkipError,
  TooManyRedirectsError, describeError, isAbortError, isRetryable,
} from '../util/errors.js';
import { atomicWriteFile, moveFile } from '../util/fs.js';
import { backoffDelay } from '../util/time.js';

const MB = 1024 * 1024;
const STOP_GRACE_MS = 15_000;

export class Crawler {
  /**
   * @param {object} opts
   * @param {object} opts.job job row
   * @param {object} opts.config effective configuration snapshot
   * @param {import('../jobs/store.js').JobStore} opts.store
   * @param {object} opts.logger
   * @param {object} [opts.deps] test hooks: { resolveOverride, isBlockedAddress }
   */
  constructor({ job, config, store, logger, deps = {} }) {
    this.job = job;
    this.jobId = job.id;
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.startUrl = new URL(job.start_url);
    this.outputDir = job.output_dir;
    this.stagingDir = path.join(job.job_dir, 'staging');
    this.tmpDir = path.join(job.output_dir, '.tmp');

    this.scope = createScope(config.website, this.startUrl);
    this.rules = createPageRules(config.crawler);
    this.normalizePage = createPageNormalizer(config.crawler);
    this.assetFilter = createAssetFilter(config, this.scope);
    this.http = new HttpClient({
      userAgent: config.crawler.userAgent,
      allowPrivateNetworks: config.network.allowPrivateNetworks,
      resolveOverride: deps.resolveOverride ?? null,
      ...(deps.isBlockedAddress ? { isBlockedAddress: deps.isBlockedAddress } : {}),
    });
    this.robots = new RobotsManager({
      httpClient: this.http,
      userAgent: config.crawler.userAgent,
      enabled: config.crawler.respectRobotsTxt,
      logger,
      retries: config.crawler.retries,
      retryBackoffMs: config.crawler.retryBackoffMs,
    });
    this.pageLimiter = new HostRateLimiter(config.crawler.requestDelayMs);
    this.assetLimiter = new HostRateLimiter(config.download.requestDelayMs);
    this.renderer = config.crawler.renderer === 'browser'
      ? new BrowserRenderer({
        crawler: config.crawler, httpClient: this.http, allowPrivateNetworks: config.network.allowPrivateNetworks, logger,
      })
      : null;

    this.abort = new AbortController();
    this.stopKind = null;
    this.active = { page: 0, asset: 0 };
    this.waiters = new Set();
    this.lastActivityWrite = 0;
    this.recorded = 0;
    this.accepted = 0;
    this.unrecorded = job.unrecorded_urls || 0;
    this.trapWarnings = new Set();
  }

  // ---- control --------------------------------------------------------------

  /** Ask the crawl to stop claiming work; in-flight items get a grace period. */
  requestStop(kind) {
    if (this.stopKind) return;
    this.stopKind = kind;
    this.#wakeAll();
    const grace = kind === 'lost' || kind === 'fatal' ? 0 : STOP_GRACE_MS;
    this.stopTimer = setTimeout(() => this.abort.abort(new AbortedError()), grace);
    this.stopTimer.unref?.();
  }

  get signal() {
    return this.abort.signal;
  }

  #wakeAll() {
    for (const w of [...this.waiters]) w();
  }

  #waitForWork(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  setActivity(text, force = false) {
    const now = Date.now();
    if (!force && now - this.lastActivityWrite < 750) return;
    this.lastActivityWrite = now;
    try {
      this.store.updateJob(this.jobId, { current_activity: text.slice(0, 500) });
    } catch (err) {
      this.logger.debug(`Could not record activity: ${err.message}`);
    }
  }

  // ---- lifecycle ------------------------------------------------------------

  async prepare() {
    await fsp.mkdir(path.join(this.stagingDir, 'pages'), { recursive: true });
    await fsp.mkdir(path.join(this.stagingDir, 'css'), { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
    this.recorded = this.store.countRecordedUrls(this.jobId);
    this.accepted = this.store.countAcceptedPages(this.jobId);
    if (this.job.run_count > 1) await this.#verifyDownloadedAssets();
  }

  /** On resume: re-queue downloaded assets whose files disappeared (or all, with existingFiles=overwrite). */
  async #verifyDownloadedAssets() {
    const overwrite = this.config.download.existingFiles === 'overwrite';
    let requeued = 0;
    let after = 0;
    for (;;) {
      const batch = this.store.assetsBatch(this.jobId, after);
      if (!batch.length) break;
      after = batch[batch.length - 1].id;
      for (const row of batch) {
        if (row.status !== AssetStatus.DOWNLOADED) continue;
        let missing = overwrite;
        if (!missing) {
          try {
            await fsp.access(safeJoin(this.outputDir, row.local_path));
          } catch {
            missing = true;
          }
        }
        if (missing) {
          this.store.updateAsset(row.id, { status: AssetStatus.PENDING, attempts: 0, next_attempt_at: 0 });
          requeued++;
        }
      }
    }
    if (requeued) this.logger.info(`Re-queued ${requeued} previously downloaded asset(s) (${overwrite ? 'existingFiles=overwrite' : 'file missing'})`);
  }

  async run() {
    await this.prepare();
    if (!this.job.seeded) await this.seed();
    const loops = [];
    for (let i = 0; i < this.config.crawler.concurrency; i++) loops.push(this.#loop('page'));
    if (this.config.download.enabled) {
      for (let i = 0; i < this.config.download.concurrency; i++) loops.push(this.#loop('asset'));
    }
    const results = await Promise.allSettled(loops);
    clearTimeout(this.stopTimer);
    const failure = results.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
    if (this.unrecorded !== (this.job.unrecorded_urls || 0)) {
      this.store.updateJob(this.jobId, { unrecorded_urls: this.unrecorded });
    }
    return this.stopKind ? 'stopped' : 'finished';
  }

  async close() {
    clearTimeout(this.stopTimer);
    if (this.renderer) await this.renderer.close().catch(() => {});
    this.http.close();
  }

  #isFinished() {
    return this.active.page === 0 && this.active.asset === 0 && this.store.remainingWork(this.jobId).total === 0;
  }

  async #loop(kind) {
    try {
      await this.#loopBody(kind);
    } catch (err) {
      // Item-level errors are handled per item; anything reaching here (e.g. a
      // database failure) is fatal: stop every other loop before reporting it.
      this.requestStop('fatal');
      throw err;
    }
  }

  async #loopBody(kind) {
    while (!this.stopKind) {
      let item;
      try {
        item = kind === 'page' ? this.store.claimNextPage(this.jobId) : this.store.claimNextAsset(this.jobId);
      } catch (err) {
        this.logger.error(`Could not claim ${kind}: ${describeError(err)}`);
        throw err;
      }
      if (!item) {
        if (this.#isFinished()) {
          this.#wakeAll();
          return;
        }
        const due = kind === 'page' ? this.store.nextPageDueAt(this.jobId) : this.store.nextAssetDueAt(this.jobId);
        const wait = due && due > Date.now() ? Math.min(1000, due - Date.now()) : 500;
        await this.#waitForWork(wait);
        continue;
      }
      this.active[kind]++;
      try {
        if (kind === 'page') await this.processPage(item);
        else await this.processAsset(item);
      } finally {
        this.active[kind]--;
        this.#wakeAll();
      }
    }
  }

  // ---- seeding --------------------------------------------------------------

  async seed() {
    this.store.tx(() => this.enqueuePage(this.job.start_url, { depth: 0, source: 'start', isStart: true }));
    const sm = this.config.crawler.sitemap;
    if (sm.enabled && sm.maxUrls > 0) {
      this.setActivity('Discovering sitemaps', true);
      try {
        let declared = [];
        try {
          declared = (await this.robots.get(this.startUrl.origin, this.signal)).sitemaps;
        } catch (err) {
          if (isAbortError(err)) throw err;
        }
        const urls = await discoverSitemapUrls({
          httpClient: this.http,
          startUrl: this.startUrl.href,
          declared,
          isAllowedHost: (h) => this.scope.isInternalHost(h),
          maxUrls: sm.maxUrls,
          maxSitemaps: sm.maxSitemaps,
          signal: this.signal,
          logger: this.logger,
          timeoutMs: this.config.crawler.navigationTimeoutMs,
        });
        let added = 0;
        this.store.tx(() => {
          for (const u of urls) if (this.enqueuePage(u, { depth: 1, source: 'sitemap' })) added++;
        });
        if (urls.length) this.logger.info(`Sitemaps: ${urls.length} URLs found, ${added} newly queued`);
      } catch (err) {
        if (isAbortError(err)) return; // seeding resumes on the next run
        this.logger.warn(`Sitemap discovery failed: ${describeError(err)}`);
      }
    }
    if (!this.stopKind) this.store.updateJob(this.jobId, { seeded: 1 });
  }

  // ---- enqueueing -------------------------------------------------------------

  #recordable() {
    if (this.recorded >= this.config.crawler.trapProtection.maxDiscoveredUrls) {
      this.unrecorded++;
      if (this.unrecorded === 1) {
        this.logger.warn(`crawler.trapProtection.maxDiscoveredUrls (${this.config.crawler.trapProtection.maxDiscoveredUrls}) reached; further URLs are counted but not recorded`);
      }
      return false;
    }
    return true;
  }

  #trapWarn(code, message) {
    if (this.trapWarnings.has(code)) return;
    this.trapWarnings.add(code);
    this.logger.warn(`Crawl limit reached (${code}): ${message}. Further matching URLs are skipped.`);
  }

  /**
   * Record a discovered page URL (queued or skipped with a reason).
   * Must be called inside a store transaction for batches.
   * @returns {boolean} true if newly queued
   */
  enqueuePage(rawUrl, { base, depth, source, parentUrl = null, isStart = false, fromExternal = false }) {
    if (isIgnoredReference(rawUrl)) return false;
    const n = this.normalizePage(rawUrl, base);
    if (!n.ok) return false;
    const { url, key, fetchUrl } = n;
    const c = this.config.crawler;

    if (!isStart && !looksLikePage(url) && this.scope.isInternalHost(url.hostname)) {
      // Internal links to files (PDFs, images, archives...) are downloads, not pages.
      this.enqueueAsset(url.href, { hint: categoryFromExtension(extensionOf(url.pathname)) || 'other', referrer: parentUrl });
      return false;
    }

    const existing = this.store.findPage(this.jobId, key);
    if (existing) {
      if (existing.status === PageStatus.SKIPPED && existing.reason_code === 'max-depth' && c.maxDepth != null && depth <= c.maxDepth) {
        this.store.updatePage(existing.id, { status: PageStatus.QUEUED, depth, reason_code: null, reason: null, source, parent_url: parentUrl });
        this.accepted++;
        this.#wakeAll();
        return true;
      }
      return false;
    }
    if (this.store.findAlias(this.jobId, key) !== null) return false;
    if (!this.#recordable()) return false;

    const cls = this.scope.classifyPageHost(url.hostname);
    let skip = null;
    if (cls.scope === 'excluded') skip = { code: 'out-of-scope', message: cls.reason };
    else if (cls.scope === 'external' && fromExternal) skip = { code: 'external-link', message: 'links found on external pages are not followed' };
    if (!skip) skip = this.rules.check(url, { isStart });
    if (!skip && c.maxDepth != null && depth > c.maxDepth) skip = { code: 'max-depth', message: `depth ${depth} exceeds crawler.maxDepth (${c.maxDepth})` };

    const pathKey = pathKeyOf(url);
    const pattern = patternOf(url);
    const trap = c.trapProtection;
    if (!skip && url.search && trap.maxQueryVariantsPerPath != null
      && this.store.countPagesWhere(this.jobId, 'path_key', pathKey) >= trap.maxQueryVariantsPerPath) {
      skip = { code: 'trap-query-variants', message: `more than ${trap.maxQueryVariantsPerPath} query variants of ${pathKey}` };
      this.#trapWarn(skip.code, skip.message);
    }
    if (!skip && trap.maxUrlsPerPattern != null
      && this.store.countPagesWhere(this.jobId, 'pattern', pattern) >= trap.maxUrlsPerPattern) {
      skip = { code: 'trap-pattern', message: `more than ${trap.maxUrlsPerPattern} URLs share the pattern ${pattern}` };
      this.#trapWarn(skip.code, skip.message);
    }
    if (!skip && c.maxPages != null && this.accepted >= c.maxPages) {
      skip = { code: 'max-pages', message: `crawler.maxPages (${c.maxPages}) reached` };
    }

    const id = this.store.insertPage({
      job_id: this.jobId,
      url: key,
      fetch_url: fetchUrl,
      path_key: pathKey,
      pattern,
      depth,
      external: cls.scope === 'external' ? 1 : 0,
      status: skip ? PageStatus.SKIPPED : PageStatus.QUEUED,
      source,
      parent_url: parentUrl,
      reason_code: skip?.code ?? null,
      reason: skip?.message ?? null,
    });
    if (id === null) return false;
    this.recorded++;
    if (skip) return false;
    this.accepted++;
    this.#wakeAll();
    return true;
  }

  /** Record a discovered asset URL (pending or skipped with a reason). */
  enqueueAsset(rawUrl, { base, hint = 'other', referrer = null, cssDepth = 0 } = {}) {
    if (!this.config.download.enabled) return false;
    if (isIgnoredReference(rawUrl)) return false;
    const n = normalizeAssetUrl(rawUrl, base);
    if (!n.ok) return false;
    if (this.store.findAsset(this.jobId, n.key)) return false;
    if (this.store.findAssetByFinalUrl(this.jobId, n.key)) return false;
    if (!this.#recordable()) return false;
    const skip = this.assetFilter.beforeRequest(n.url, hint, cssDepth);
    const id = this.store.insertAsset({
      job_id: this.jobId,
      url: n.key,
      status: skip ? AssetStatus.SKIPPED : AssetStatus.PENDING,
      hint,
      css_depth: cssDepth,
      referrer,
      reason_code: skip?.code ?? null,
      reason: skip?.message ?? null,
    });
    if (id === null) return false;
    this.recorded++;
    if (!skip) this.#wakeAll();
    return !skip;
  }

  // ---- pages ----------------------------------------------------------------

  #pageRedirectCheck(page) {
    return (next) => {
      const cls = this.scope.classifyPageHost(next.hostname);
      if (cls.scope === 'excluded') return cls.reason;
      if (cls.scope === 'external' && !page.external && !this.config.website.crawlExternalPages) return 'external host';
      const rule = this.rules.check(next, { isStart: page.source === 'start' });
      if (rule) return rule.message;
      return null;
    };
  }

  #navigationAllowed(rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol === 'about:' || u.protocol === 'data:';
      return this.scope.classifyPageHost(u.hostname).scope !== 'excluded';
    } catch {
      return false;
    }
  }

  #retryOrFail(kind, item, err) {
    const isPage = kind === 'page';
    const settings = isPage ? this.config.crawler : this.config.download;
    const update = (fields) => (isPage ? this.store.updatePage(item.id, fields) : this.store.updateAsset(item.id, fields));
    const pending = isPage ? PageStatus.QUEUED : AssetStatus.PENDING;
    const label = isPage ? 'Page' : 'Asset';
    if (isRetryable(err) && item.attempts <= settings.retries) {
      const delay = Math.max(err.retryAfterMs ?? 0, backoffDelay(settings.retryBackoffMs, item.attempts));
      if (err instanceof HttpStatusError && err.retryAfterMs) {
        (isPage ? this.pageLimiter : this.assetLimiter).penalize(new URL(item.url).host, err.retryAfterMs);
      }
      update({ status: pending, next_attempt_at: Date.now() + delay, reason_code: 'retrying', reason: describeError(err) });
      this.logger.warn(`${label} ${redactUrl(item.url)} failed (attempt ${item.attempts}/${settings.retries + 1}): ${describeError(err)}; retrying in ${Math.round(delay / 1000)}s`);
      return;
    }
    const code = err instanceof HttpStatusError ? `http-${err.status}` : (err.code || 'error').toString().toLowerCase();
    update({ status: isPage ? PageStatus.FAILED : AssetStatus.FAILED, reason_code: code, reason: describeError(err) });
    this.store.updateJob(this.jobId, { last_error: `${redactUrl(item.url)}: ${describeError(err)}` });
    this.logger.warn(`${label} failed: ${redactUrl(item.url)} - ${describeError(err)}`);
  }

  async processPage(page) {
    const signal = this.signal;
    const fetchUrl = new URL(page.fetch_url);
    const c = this.config.crawler;
    try {
      const robots = await this.robots.check(fetchUrl, signal);
      if (!robots.allowed) {
        this.store.updatePage(page.id, { status: PageStatus.SKIPPED, reason_code: 'robots', reason: robots.reason });
        this.logger.info(`Skipped (robots.txt): ${redactUrl(fetchUrl.href)}`);
        return;
      }
      if (robots.crawlDelayMs) this.pageLimiter.setMinInterval(fetchUrl.host, Math.min(robots.crawlDelayMs, c.maxRobotsCrawlDelayMs));
      await this.pageLimiter.wait(fetchUrl.host, signal);
      this.setActivity(`Fetching ${redactUrl(fetchUrl.href)}`);

      const pre = await this.http.fetch(fetchUrl.href, {
        signal,
        timeoutMs: c.navigationTimeoutMs,
        maxBytes: Math.floor(c.maxPageSizeMb * MB),
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        maxRedirects: c.maxRedirects,
        checkRedirect: this.#pageRedirectCheck(page),
        onHeaders: (info) => (info.status < 300 && info.mime && !isHtmlMime(info.mime) ? { stop: true } : null),
      });

      if (pre.status >= 400) throw new HttpStatusError(pre.status, pre.finalUrl);
      if (pre.status >= 300) throw new Error(`Unexpected HTTP ${pre.status} without a usable redirect`);

      const notHtml = pre.stopped || (!pre.mime && pre.body && !looksLikeHtml(pre.body));
      if (notHtml) {
        const hint = categoryFromMime(pre.mime) || categoryFromExtension(extensionOf(fetchUrl.pathname)) || 'other';
        this.store.tx(() => this.enqueueAsset(fetchUrl.href, { hint: hint === 'html' ? 'other' : hint, referrer: page.parent_url }));
        this.store.updatePage(page.id, {
          status: PageStatus.SKIPPED, http_status: pre.status, content_type: pre.mime,
          reason_code: 'not-html', reason: `served as ${pre.mime || 'unknown type'}; handled as a downloadable file`,
        });
        return;
      }

      const finalN = this.normalizePage(pre.finalUrl);
      if (finalN.ok && finalN.key !== page.url) {
        const duplicate = this.store.tx(() => {
          const other = this.store.findPage(this.jobId, finalN.key);
          const aliasOwner = this.store.findAlias(this.jobId, finalN.key);
          const ownerId = other && other.id !== page.id ? other.id : aliasOwner !== null && aliasOwner !== page.id ? aliasOwner : null;
          if (ownerId !== null) {
            this.store.addAlias(this.jobId, page.url, ownerId);
            return true;
          }
          this.store.addAlias(this.jobId, finalN.key, page.id);
          return false;
        });
        if (duplicate) {
          this.store.updatePage(page.id, {
            status: PageStatus.SKIPPED, final_url: pre.finalUrl, http_status: pre.status,
            reason_code: 'duplicate-redirect', reason: `redirects to ${pre.finalUrl}, which is already captured`,
          });
          return;
        }
      }

      const sourceHtml = decodeHtml(pre.body, pre.charset);
      let renderedHtml = null;
      let documentUrl = pre.finalUrl;
      if (this.renderer) {
        this.setActivity(`Rendering ${redactUrl(pre.finalUrl)}`);
        const r = await this.renderer.render(
          pre.finalUrl,
          { status: pre.status, headers: pre.headers, body: pre.body },
          signal,
          (u) => this.#navigationAllowed(u),
        );
        renderedHtml = r.html;
        for (const blocked of r.blockedNavigations) {
          this.logger.info(`Blocked client-side navigation from ${redactUrl(pre.finalUrl)} to out-of-scope ${redactUrl(blocked)}`);
        }
        if (r.finalUrl && r.finalUrl !== pre.finalUrl && /^https?:/i.test(r.finalUrl)) {
          const target = new URL(r.finalUrl);
          if (this.scope.classifyPageHost(target.hostname).scope === 'excluded') {
            this.store.updatePage(page.id, {
              status: PageStatus.SKIPPED, final_url: pre.finalUrl, http_status: pre.status,
              reason_code: 'js-redirect-out-of-scope', reason: `client-side navigation to ${redactUrl(r.finalUrl)} left the allowed hosts`,
            });
            return;
          }
          this.store.tx(() => this.enqueuePage(r.finalUrl, { depth: page.depth, source: 'redirect', parentUrl: page.url }));
        }
      }

      const linkHtml = renderedHtml ?? sourceHtml;
      const saveHtml = renderedHtml && this.config.output.saveRenderedHtml ? renderedHtml : sourceHtml;
      const linkRefs = extractReferences(linkHtml, documentUrl);
      const saveRefs = saveHtml === linkHtml ? linkRefs : extractReferences(saveHtml, documentUrl);

      this.store.tx(() => {
        if (!page.external) {
          for (const link of linkRefs.links) {
            this.enqueuePage(link, { depth: page.depth + 1, source: 'link', parentUrl: page.url });
          }
        }
        for (const a of saveRefs.assets) this.enqueueAsset(a.url, { hint: a.hint, referrer: page.url });
      });

      await atomicWriteFile(stagingPagePath(this.job, page.id), saveHtml, { encoding: 'utf8' });
      const docUrl = new URL(documentUrl);
      const preferred = pageLocalPath(docUrl, {
        primaryHost: this.startUrl.hostname,
        primaryPort: this.startUrl.port,
        preserveStructure: this.config.output.preserveStructure,
        isStart: page.source === 'start',
      });
      const localPath = this.store.reservePath(this.jobId, `page:${page.id}`, preferred);
      this.store.updatePage(page.id, {
        status: PageStatus.COMPLETED, final_url: documentUrl, http_status: pre.status, content_type: pre.mime,
        local_path: localPath, reason_code: null, reason: null,
      });
      this.logger.info(`Page ${page.depth}: ${redactUrl(documentUrl)} -> ${localPath} (${linkRefs.links.length} links, ${saveRefs.assets.length} asset refs)`);
    } catch (err) {
      this.#handlePageError(page, err);
    }
  }

  #handlePageError(page, err) {
    if (isAbortError(err) || (this.stopKind && this.signal.aborted)) {
      this.store.updatePage(page.id, { status: PageStatus.QUEUED, attempts: Math.max(0, page.attempts - 1) });
      return;
    }
    if (err instanceof RedirectScopeError || err instanceof TooManyRedirectsError) {
      this.store.updatePage(page.id, { status: PageStatus.SKIPPED, reason_code: err instanceof RedirectScopeError ? 'redirect-out-of-scope' : 'too-many-redirects', reason: describeError(err) });
      this.logger.info(`Skipped ${redactUrl(page.fetch_url)}: ${describeError(err)}`);
      return;
    }
    if (err instanceof BlockedRequestError) {
      this.store.updatePage(page.id, { status: PageStatus.SKIPPED, reason_code: 'blocked-network', reason: describeError(err) });
      this.logger.warn(`Blocked ${redactUrl(page.fetch_url)}: ${describeError(err)}`);
      return;
    }
    if (err instanceof SizeLimitError) {
      this.store.updatePage(page.id, { status: PageStatus.SKIPPED, reason_code: 'too-large', reason: `page exceeds crawler.maxPageSizeMb (${this.config.crawler.maxPageSizeMb} MB)` });
      return;
    }
    this.#retryOrFail('page', page, err);
  }

  // ---- assets -----------------------------------------------------------------

  async processAsset(asset) {
    const signal = this.signal;
    const url = new URL(asset.url);
    const tmp = path.join(this.tmpDir, `${asset.id}-${randomBytes(4).toString('hex')}.part`);
    try {
      await this.assetLimiter.wait(url.host, signal);
      this.setActivity(`Downloading ${redactUrl(asset.url)}`);
      let category = asset.hint || 'other';
      let sniffed = null;
      const res = await this.http.download(asset.url, tmp, {
        signal,
        timeoutMs: this.config.download.timeoutMs,
        maxBytes: this.assetFilter.maxBytes,
        maxRedirects: this.config.crawler.maxRedirects,
        checkRedirect: (next) => this.assetFilter.checkRedirect(next),
        onHeaders: (info) => {
          category = this.assetFilter.afterHeaders(info, asset.hint, asset.url);
        },
        onFirstBytes: (buf, info) => {
          sniffed = this.assetFilter.afterFirstBytes(buf, info);
          if (sniffed && (!info.mime || categoryFromMime(info.mime) === null)) category = sniffed.category;
        },
      });

      const finalN = normalizeAssetUrl(res.finalUrl);
      const finalKey = finalN.ok ? finalN.key : asset.url;
      if (finalKey !== asset.url) {
        const existing = this.store.findAssetByFinalUrl(this.jobId, finalKey)
          || (() => {
            const direct = this.store.findAsset(this.jobId, finalKey);
            return direct?.status === AssetStatus.DOWNLOADED ? direct : null;
          })();
        if (existing && existing.id !== asset.id && existing.local_path) {
          await fsp.rm(tmp, { force: true });
          this.store.updateAsset(asset.id, {
            status: AssetStatus.DOWNLOADED, final_url: finalKey, category: existing.category, mime: existing.mime,
            size: existing.size, local_path: existing.local_path, reason_code: 'duplicate-redirect', reason: `same file as ${existing.url}`,
          });
          return;
        }
      }

      const mime = this.assetFilter.effectiveMime(res, sniffed, asset.url);
      const preferred = assetLocalPath(url, { mime, category, preserveStructure: this.config.output.preserveStructure });
      const localPath = this.store.reservePath(this.jobId, `asset:${asset.id}`, preferred);
      const dest = safeJoin(this.outputDir, localPath);
      await moveFile(tmp, dest);

      let staged = 0;
      if (category === 'stylesheet') {
        const buf = await fsp.readFile(dest);
        await atomicWriteFile(stagingCssPath(this.job, asset.id), buf);
        staged = 1;
        const { text } = decodeCssBuffer(buf);
        const refs = findCssReferences(text);
        this.store.tx(() => {
          for (const ref of refs) {
            let resolved;
            try {
              resolved = new URL(ref.value, finalKey).href;
            } catch {
              continue;
            }
            this.enqueueAsset(resolved, { hint: cssReferenceHint(ref, resolved), referrer: asset.url, cssDepth: asset.css_depth + 1 });
          }
        });
      }

      this.store.updateAsset(asset.id, {
        status: AssetStatus.DOWNLOADED, final_url: finalKey, category, mime, size: res.bytes, local_path: localPath,
        staged, reason_code: null, reason: null,
      });
      this.logger.debug(`Asset ${category}: ${redactUrl(asset.url)} -> ${localPath} (${res.bytes} bytes)`);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      this.#handleAssetError(asset, err);
    }
  }

  #handleAssetError(asset, err) {
    if (isAbortError(err) || (this.stopKind && this.signal.aborted)) {
      this.store.updateAsset(asset.id, { status: AssetStatus.PENDING, attempts: Math.max(0, asset.attempts - 1) });
      return;
    }
    let skip = null;
    if (err instanceof SkipError) skip = { code: err.reasonCode, message: err.message };
    else if (err instanceof SizeLimitError) {
      const limit = this.config.download.maxFileSizeMb;
      skip = { code: 'too-large', message: `${err.declared != null ? `declared size ${err.declared} bytes` : 'streamed size'} exceeds download.maxFileSizeMb (${limit} MB)` };
    } else if (err instanceof RedirectScopeError) skip = { code: 'redirect-out-of-scope', message: describeError(err) };
    else if (err instanceof TooManyRedirectsError) skip = { code: 'too-many-redirects', message: describeError(err) };
    else if (err instanceof BlockedRequestError) skip = { code: 'blocked-network', message: describeError(err) };
    if (skip) {
      this.store.updateAsset(asset.id, { status: AssetStatus.SKIPPED, reason_code: skip.code, reason: skip.message });
      this.logger.debug(`Asset skipped (${skip.code}): ${redactUrl(asset.url)} - ${skip.message}`);
      return;
    }
    this.#retryOrFail('asset', asset, err);
  }
}

export function stagingPagePath(job, pageId) {
  return path.join(job.job_dir, 'staging', 'pages', `${pageId}.html`);
}

export function stagingCssPath(job, assetId) {
  return path.join(job.job_dir, 'staging', 'css', `${assetId}.css`);
}
