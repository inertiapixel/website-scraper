/**
 * JavaScript-rendered site tests (Chromium via Playwright). Skipped with a
 * clear message when the browser has not been installed.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startServer, siteHandler, html, bytes, SIGNATURES } from '../helpers/fixtures.js';
import { runTestJob } from '../helpers/run-job.js';

const browserInstalled = fs.existsSync(chromium.executablePath());
const skip = browserInstalled ? false : 'Chromium is not installed (run: npm run browsers:install)';
const png = Buffer.concat([SIGNATURES.png, bytes(32)]);

describe('JavaScript-rendered pages', { skip }, () => {
  let server;
  let resolver;
  const pending = new Set();
  before(async () => {
    const routes = {
      '/': {
        body: html(`
          <div id="app">Loading...</div>
          <div style="height:4000px">spacer</div>
          <img id="lazy" data-src="/img/lazy.png" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="lazy">
          <script>
            setTimeout(() => {
              document.getElementById('app').innerHTML = '<a href="/client-route">Client route</a><img src="/img/rendered.png">';
            }, 150);
            new IntersectionObserver((entries, io) => entries.forEach((e) => {
              if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); }
            })).observe(document.getElementById('lazy'));
            const st = document.createElement('style');
            document.head.appendChild(st);
            st.sheet.insertRule('.css-in-js { background-image: url(/img/cssinjs.png); color: rebeccapurple; }');
            fetch('/long-poll').catch(() => {});
          </script>`),
      },
      '/client-route': { body: html('<h1>Only reachable through JavaScript</h1>') },
      '/js-redirect': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html(`<h1>Before redirect</h1><script>setTimeout(() => { location.href = 'http://evil.test:${server.port}/'; }, 50)</script>`));
      },
      '/img/lazy.png': { type: 'image/png', body: png },
      '/img/rendered.png': { type: 'image/png', body: png },
      '/img/cssinjs.png': { type: 'image/png', body: png },
      '/long-poll': (req, res) => {
        pending.add(res); // never answered: must not block page settling
      },
    };
    server = await startServer(siteHandler(routes));
    resolver = (h) => (h === 'spa.test' || h === 'evil.test' ? [{ address: '127.0.0.1', family: 4 }] : null);
  });
  after(async () => {
    for (const res of pending) res.destroy();
    await server.close();
  });

  test('links, lazy images and CSS-in-JS created by scripts are captured', async () => {
    const start = `http://spa.test:${server.port}/`;
    const r = await runTestJob({ startUrl: start, resolveOverride: resolver, overrides: { crawler: { renderer: 'browser' } } });
    try {
      assert.equal(r.job.status, 'COMPLETED', r.job.last_error);
      assert.equal(r.page(`http://spa.test:${server.port}/client-route`)?.status, 'COMPLETED', 'link added by JavaScript was crawled');
      for (const p of ['/img/rendered.png', '/img/lazy.png', '/img/cssinjs.png']) {
        assert.equal(r.asset(`http://spa.test:${server.port}${p}`)?.status, 'DOWNLOADED', p);
      }
      const saved = fs.readFileSync(r.out('index.html'), 'utf8');
      const A = `_assets/spa.test_${server.port}/img`;
      assert.ok(saved.includes('href="client-route/index.html"'));
      assert.ok(saved.includes(`src="${A}/rendered.png"`));
      assert.ok(saved.includes(`src="${A}/lazy.png"`), 'lazy image captured after scrolling');
      assert.match(saved, new RegExp(`\\.css-in-js \\{[^}]*url\\("${A}/cssinjs\\.png"\\)`), 'CSSOM rules serialized and rewritten');
    } finally {
      r.store.close();
    }
  });

  test('client-side navigation to an out-of-scope host is blocked inside the browser', async () => {
    const r = await runTestJob({
      startUrl: `http://spa.test:${server.port}/js-redirect`, resolveOverride: resolver,
      overrides: { crawler: { renderer: 'browser', maxDepth: 0, settle: { delayMs: 300 } } },
    });
    try {
      assert.equal(r.job.status, 'COMPLETED', r.job.last_error);
      assert.equal([...server.hits.keys()].filter((k) => k.startsWith('evil.test')).length, 0, 'external host never contacted');
      assert.match(fs.readFileSync(r.out('js-redirect/index.html'), 'utf8'), /Before redirect/);
    } finally {
      r.store.close();
    }
  });

  test('the HTTP renderer does not see JavaScript-only links', async () => {
    const r = await runTestJob({ startUrl: `http://spa.test:${server.port}/`, resolveOverride: resolver, overrides: { crawler: { renderer: 'http' } } });
    assert.equal(r.page(`http://spa.test:${server.port}/client-route`), null);
    r.store.close();
  });
});

describe('browser network guard', { skip }, () => {
  test('browser requests and redirects to blocked addresses never reach the target', async () => {
    let port;
    const dual = await startServer((req, res, { host }) => {
      if (host === 'public.test' && req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(html(`
          <p>public page</p>
          <img src="http://redirector.test:${port}/hop.png">
          <img src="http://internal.test:${port}/direct.png">
          <script>fetch('http://redirector.test:${port}/hop-fetch').catch(() => {})</script>`));
      }
      if (host === 'redirector.test') {
        res.writeHead(302, { location: `http://internal.test:${port}/secret${req.url}` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(png);
    }, { listenHost: '::' });
    port = dual.port;
    // Policy for this test: 127.0.0.1 is "public", ::1 is "internal" (blocked).
    const addresses = {
      'public.test': [{ address: '127.0.0.1', family: 4 }],
      'redirector.test': [{ address: '127.0.0.1', family: 4 }],
      'internal.test': [{ address: '::1', family: 6 }],
    };
    const r = await runTestJob({
      startUrl: `http://public.test:${port}/`,
      resolveOverride: (h) => addresses[h] ?? null,
      deps: { isBlockedAddress: (a) => a === '::1' },
      overrides: { crawler: { renderer: 'browser', sitemap: { enabled: false }, respectRobotsTxt: false }, network: { allowPrivateNetworks: false } },
    });
    try {
      assert.equal(r.job.status, 'COMPLETED', r.job.last_error);
      const internalHits = [...dual.hits.keys()].filter((k) => k.startsWith('internal.test'));
      assert.deepEqual(internalHits, [], 'no request (direct, redirected, image or fetch) reached the blocked host');
      assert.ok(dual.hitCount('redirector.test/hop.png') >= 1, 'the allowed first hop was requested');
      assert.equal(r.asset(`http://internal.test:${port}/direct.png`).reason_code, 'blocked-network');
      assert.equal(r.asset(`http://redirector.test:${port}/hop.png`).reason_code, 'blocked-network');
    } finally {
      r.store.close();
      await dual.close();
    }
  });
});
