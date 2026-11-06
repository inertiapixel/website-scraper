/**
 * Playwright/Chromium page renderer.
 *
 * The main document is fetched first by the HTTP client (scope-checked
 * redirects, size limit) and handed to Chromium with `route.fulfill`, so the
 * browser never navigates to a URL the crawler did not validate. All other
 * browser traffic goes through the SSRF guard proxy.
 *
 * Page readiness = navigation event (`settle.waitUntil`) + bounded
 * network-quiet window + optional selector + lazy-load scrolling + fixed
 * delay. `networkidle` is never required: long-polling, analytics and
 * streaming connections only cost the configured quiet-timeout.
 */
import { chromium } from 'playwright';
import { GuardProxy } from '../net/guard-proxy.js';
import { AbortedError, TimeoutError } from '../util/errors.js';
import { sleep } from '../util/time.js';

const PASS_HEADERS = new Set(['content-type', 'content-language', 'last-modified']);

/** Runs inside the page: make CSS-in-JS rules (inserted via CSSOM) visible in the serialized DOM. */
function snapshotCssom() {
  for (const style of document.querySelectorAll('style')) {
    const sheet = style.sheet;
    if (!sheet) continue;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    if (!rules || !rules.length) continue;
    const text = style.textContent || '';
    let parsedCount = -1;
    try {
      const probe = new CSSStyleSheet();
      probe.replaceSync(text);
      parsedCount = probe.cssRules.length;
    } catch {
      /* ignore */
    }
    if (!text.trim() || (parsedCount >= 0 && rules.length > parsedCount)) {
      style.textContent = Array.from(rules, (r) => r.cssText).join('\n');
    }
  }
  const adopted = document.adoptedStyleSheets || [];
  if (adopted.length && document.head) {
    const el = document.createElement('style');
    el.setAttribute('data-website-scraper', 'adopted-stylesheets');
    el.textContent = adopted.map((s) => Array.from(s.cssRules, (r) => r.cssText).join('\n')).join('\n');
    document.head.appendChild(el);
  }
}

/** Runs inside the page: scroll in steps so lazy-loaded content is requested. */
async function autoScroll({ maxScrolls, delay }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const root = document.scrollingElement || document.documentElement;
  for (let i = 0; i < maxScrolls; i++) {
    const before = root.scrollHeight;
    window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.85)));
    await wait(delay);
    const atBottom = window.scrollY + window.innerHeight >= root.scrollHeight - 2;
    if (atBottom && root.scrollHeight === before) break;
  }
  window.scrollTo(0, 0);
  await wait(delay);
}

export class BrowserRenderer {
  /**
   * @param {object} opts
   * @param {object} opts.crawler crawler config section
   * @param {import('../net/http-client.js').HttpClient} opts.httpClient
   * @param {boolean} opts.allowPrivateNetworks
   * @param {object} opts.logger
   */
  constructor({ crawler, httpClient, allowPrivateNetworks, logger }) {
    this.config = crawler;
    this.httpClient = httpClient;
    this.allowPrivateNetworks = allowPrivateNetworks;
    this.logger = logger;
    this.browser = null;
    this.context = null;
    this.proxy = null;
    this.launching = null;
    this.pages = new Set();
    this.closed = false;
    this.blockedTypes = new Set(crawler.blockBrowserResourceTypes);
  }

  async #ensure() {
    if (this.closed) throw new AbortedError('Renderer closed');
    if (this.context) return this.context;
    if (!this.launching) {
      this.launching = this.#launch().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  async #launch() {
    if (!this.proxy) {
      this.proxy = new GuardProxy({
        lookup: this.httpClient.lookup, isBlocked: this.httpClient.isBlocked, allowPrivateNetworks: this.allowPrivateNetworks, logger: this.logger,
      });
      await this.proxy.start();
    }
    this.logger.debug('Launching Chromium');
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        proxy: { server: `http://127.0.0.1:${this.proxy.port}`, bypass: '<-loopback>' },
        args: ['--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run', '--disable-quic'],
      });
    } catch (err) {
      if (/Executable doesn't exist|browserType\.launch/i.test(err.message)) {
        throw new Error(
          'Chromium is not installed for Playwright. Run "npm run browsers:install" (or "npx playwright install chromium"), ' +
          'or set crawler.renderer to "http" for static sites.',
          { cause: err },
        );
      }
      throw err;
    }
    browser.on('disconnected', () => {
      if (this.browser === browser) {
        this.browser = null;
        this.context = null;
        if (!this.closed) this.logger.warn('Chromium disconnected; it will be relaunched for the next page');
      }
    });
    const context = await browser.newContext({
      userAgent: this.config.userAgent,
      viewport: { width: 1366, height: 900 },
      serviceWorkers: 'block',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    context.setDefaultTimeout(this.config.navigationTimeoutMs);
    this.browser = browser;
    this.context = context;
    return context;
  }

  /**
   * Render a page.
   * @param {string} url the validated final URL from the preflight request
   * @param {{ status: number, headers: object, body: Buffer }} preflight
   * @param {AbortSignal} [signal]
   * @param {(url: string) => boolean} [allowNavigation] scope check for later main-frame navigations
   * @returns {Promise<{ html: string, finalUrl: string, blockedNavigations: string[] }>}
   */
  async render(url, preflight, signal, allowNavigation = () => true) {
    if (signal?.aborted) throw new AbortedError();
    const context = await this.#ensure();
    const page = await context.newPage();
    this.pages.add(page);
    const settle = this.config.settle;
    const lazy = this.config.lazyLoad;
    const budget = this.config.navigationTimeoutMs + settle.networkQuietTimeoutMs * 2 + settle.delayMs
      + (lazy.enabled ? lazy.maxScrolls * (lazy.scrollDelayMs + 50) : 0) + 15_000;

    let timer;
    const onAbort = () => page.close().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });

    let inflight = 0;
    let lastChange = Date.now();
    page.on('request', () => {
      inflight++;
      lastChange = Date.now();
    });
    const done = () => {
      inflight = Math.max(0, inflight - 1);
      lastChange = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
    const waitQuiet = async (timeoutMs) => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (inflight === 0 && Date.now() - lastChange >= settle.networkQuietMs) return true;
        await sleep(100);
      }
      return false;
    };

    let mainServed = false;
    const blockedNavigations = [];
    await page.route('**/*', async (route, request) => {
      try {
        const isMainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (!mainServed && isMainNavigation) {
          mainServed = true;
          const headers = {};
          for (const [k, v] of Object.entries(preflight.headers)) if (PASS_HEADERS.has(k)) headers[k] = String(v);
          await route.fulfill({ status: preflight.status, headers, body: preflight.body });
          return;
        }
        if (isMainNavigation && !allowNavigation(request.url())) {
          // Client-side redirect to a host outside the crawl scope: never load it.
          // A 204 response cancels a navigation and keeps the current document.
          blockedNavigations.push(request.url());
          await route.fulfill({ status: 204, body: '' });
          return;
        }
        if (this.blockedTypes.has(request.resourceType())) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.fallback();
      } catch {
        /* page closed while routing */
      }
    });

    const work = (async () => {
      await page.goto(url, { waitUntil: settle.waitUntil, timeout: this.config.navigationTimeoutMs });
      if (!(await waitQuiet(settle.networkQuietTimeoutMs))) {
        this.logger.debug(`Network not quiet after ${settle.networkQuietTimeoutMs} ms; continuing`);
      }
      if (settle.waitForSelector) {
        await page.waitForSelector(settle.waitForSelector, { timeout: this.config.navigationTimeoutMs }).catch(() => {
          this.logger.warn(`Selector "${settle.waitForSelector}" did not appear; continuing`);
        });
      }
      if (lazy.enabled && lazy.maxScrolls > 0) {
        await page.evaluate(autoScroll, { maxScrolls: lazy.maxScrolls, delay: lazy.scrollDelayMs });
        await waitQuiet(Math.min(settle.networkQuietTimeoutMs, 3000));
      }
      if (settle.delayMs) await sleep(settle.delayMs, signal);
      await page.evaluate(snapshotCssom).catch((err) => this.logger.debug(`CSSOM snapshot failed: ${err.message}`));
      const html = await page.content();
      return { html, finalUrl: page.url(), blockedNavigations };
    })();

    try {
      return await Promise.race([
        work,
        new Promise((_r, reject) => {
          timer = setTimeout(() => reject(new TimeoutError(`Rendering exceeded ${budget} ms`)), budget);
        }),
      ]);
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      work.catch(() => {});
      this.pages.delete(page);
      await page.close().catch(() => {});
    }
  }

  get blockedRequests() {
    return this.proxy?.blockedCount ?? 0;
  }

  async close() {
    this.closed = true;
    for (const p of this.pages) await p.close().catch(() => {});
    if (this.launching) await this.launching.catch(() => {});
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    if (browser) {
      await Promise.race([browser.close().catch(() => {}), sleep(10_000)]);
    }
    if (this.proxy) await this.proxy.close().catch(() => {});
    this.proxy = null;
  }
}
