import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startXyzSite } from '../helpers/site.js';
import { runTestJob } from '../helpers/run-job.js';
import { prepareResume } from '../../src/jobs/service.js';
import { runWorker } from '../../src/jobs/worker.js';

let site;
before(async () => {
  site = await startXyzSite();
});
after(async () => {
  await site.close();
});

const key = (host, p) => `http://${host}:${site.port}${p}`;
const hits = (host, p) => site.server.hitCount(`${host}${p}`);

describe('full crawl of a static site (HTTP renderer)', () => {
  let r;
  before(async () => {
    r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver });
  });
  after(() => r.store.close());

  test('the job completes', () => {
    assert.equal(r.result.exitCode, 0);
    assert.equal(r.job.status, 'COMPLETED');
    assert.ok(r.job.completed_at >= r.job.started_at);
  });

  test('internal pages are crawled recursively, including sitemap-only pages', () => {
    for (const p of ['/', '/about', '/services', '/services/team', '/page?id=1', '/page?id=2', '/sitemap-only']) {
      assert.equal(r.page(key('xyz.test', p)).status, 'COMPLETED', p);
    }
  });

  test('www, other subdomains, deceptive and external domains are never contacted', () => {
    for (const host of ['www.xyz.test', 'crm.xyz.test', 'admin.xyz.test', 'blog.xyz.test', 'notxyz.test', 'otherdomain.test']) {
      const row = r.page(key(host, '/'));
      assert.equal(row.status, 'SKIPPED', host);
      assert.equal(row.reason_code, 'out-of-scope', host);
      assert.equal([...site.server.hits.keys()].some((k) => k.startsWith(`${host}/`)), false, `${host} was contacted`);
    }
    assert.equal(r.page(key('www.xyz.test', '/not-me')).status, 'SKIPPED', 'sitemap entries obey host rules');
  });

  test('redirects that leave the allowed hosts are refused', () => {
    const row = r.page(key('xyz.test', '/redirect-out'));
    assert.equal(row.status, 'SKIPPED');
    assert.equal(row.reason_code, 'redirect-out-of-scope');
    assert.equal(hits('evil.test', '/'), 0);
    assert.equal(hits('evil.test', '/sitemap.xml'), 0, 'external sitemap declaration ignored');
  });

  test('internal redirects are deduplicated', () => {
    const files = fs.readdirSync(r.out('services/team'));
    assert.deepEqual(files, ['index.html']);
    assert.ok(['COMPLETED', 'SKIPPED'].includes(r.page(key('xyz.test', '/redirect-in')).status));
  });

  test('duplicates (trailing slash, fragment, tracking params) are fetched once', () => {
    assert.equal(hits('xyz.test', '/about'), 1);
    assert.equal(hits('xyz.test', '/about/'), 0);
    assert.equal(hits('xyz.test', '/'), 1);
    assert.equal(hits('xyz.test', '/?utm_source=newsletter'), 0);
  });

  test('robots.txt is respected', () => {
    assert.equal(r.page(key('xyz.test', '/private/secret')).reason_code, 'robots');
    assert.equal(hits('xyz.test', '/private/secret'), 0);
  });

  test('broken pages are recorded as failed with a reason', () => {
    const row = r.page(key('xyz.test', '/missing'));
    assert.equal(row.status, 'FAILED');
    assert.equal(row.reason_code, 'http-404');
  });

  test('size limit: files up to 1 MB are saved, larger ones skipped (declared or streamed)', () => {
    assert.equal(r.asset(key('xyz.test', '/img/banner.jpg')).status, 'DOWNLOADED');
    assert.equal(fs.statSync(r.out(`_assets/${site.hostDir}/img/banner.jpg`)).size, 900 * 1024 + 3);
    for (const p of ['/img/large-image.png', '/img/chunked-large.png']) {
      const a = r.asset(key('xyz.test', p));
      assert.equal(a.status, 'SKIPPED', p);
      assert.equal(a.reason_code, 'too-large', p);
      assert.equal(fs.existsSync(r.out(`_assets/${site.hostDir}${p}`)), false, `${p} must not be saved`);
    }
    assert.equal(fs.existsSync(r.out('.tmp')), false, 'no partial downloads left behind');
  });

  test('audio and video are excluded by extension (no request) and by MIME type', () => {
    for (const p of ['/media/video.mp4', '/media/audio.mp3']) {
      assert.equal(r.asset(key('xyz.test', p)).reason_code, 'excluded-extension');
      assert.equal(hits('xyz.test', p), 0, `${p} must not be requested`);
    }
    const unknown = r.asset(key('xyz.test', '/files/unknown-file'));
    assert.equal(unknown.status, 'SKIPPED');
    assert.equal(unknown.reason_code, 'excluded-mime');
    assert.equal(fs.existsSync(r.out(`_assets/${site.hostDir}/files/unknown-file`)), false);
  });

  test('CSS dependencies, fonts, images, scripts and icons are downloaded', () => {
    for (const p of ['/css/style.css', '/css/base.css', '/css/print.css', '/fonts/font.woff2', '/img/bg.png', '/img/logo.png',
      '/img/logo@2x.png', '/img/poster.png', '/img/bg-inline.png', '/img/hero.png', '/js/app.js', '/favicon.ico', '/files/brochure.pdf']) {
      assert.equal(r.asset(key('xyz.test', p)).status, 'DOWNLOADED', p);
    }
    assert.equal(r.asset(key('xyz.test', '/fonts/font.woff2')).category, 'font');
    assert.equal(r.asset(key('xyz.test', '/img/missing.png')).status, 'FAILED');
    assert.equal(hits('xyz.test', '/img/commented.png'), 0, 'commented-out CSS is ignored');
  });

  test('external CDN assets are downloaded without crawling the CDN host pages', () => {
    assert.equal(r.asset(key('cdn.test', '/lib.css')).status, 'DOWNLOADED');
    assert.equal(r.asset(key('cdn.test', '/lib-bg.png')).status, 'DOWNLOADED');
    assert.equal(r.page(key('cdn.test', '/')).status, 'SKIPPED');
    assert.equal(hits('cdn.test', '/'), 0);
  });

  test('HTML references are rewritten to local files, everything else stays absolute', () => {
    const html = fs.readFileSync(r.out('index.html'), 'utf8');
    const A = `_assets/${site.hostDir}`;
    for (const s of [
      `href="${A}/css/style.css"`, `href="_assets/cdn.test_${site.port}/lib.css"`, `href="about/index.html"`, `href="about/index.html#team"`,
      `href="services/index.html"`, `src="${A}/img/logo.png"`, `${A}/img/logo%402x.png 2x`, `src="${A}/img/banner.jpg"`,
      `poster="${A}/img/poster.png"`, `url(&quot;${A}/img/bg-inline.png&quot;)`, `url("${A}/img/hero.png")`, `@import url("${A}/css/print.css")`,
      `src="${A}/js/app.js"`, `href="${A}/files/brochure.pdf"`, 'href="#top"', 'href="mailto:hello@xyz.test"', 'src="data:image/gif;base64,',
      `src="${key('xyz.test', '/img/large-image.png')}"`, `src="${key('xyz.test', '/media/video.mp4')}"`, `href="${key('www.xyz.test', '/')}"`,
      `href="${key('xyz.test', '/missing')}"`,
    ]) {
      assert.ok(html.includes(s), `index.html should contain ${s}`);
    }
    const about = fs.readFileSync(r.out('about/index.html'), 'utf8');
    assert.ok(about.includes('href="../services/index.html"'));
    assert.ok(about.includes(`src="../${A}/img/logo.png"`));
    assert.ok(about.includes('href="../index.html"'));
  });

  test('downloaded CSS is rewritten to local relative paths', () => {
    const css = fs.readFileSync(r.out(`_assets/${site.hostDir}/css/style.css`), 'utf8');
    assert.ok(css.includes('@import "base.css";'));
    assert.ok(css.includes('url("../img/bg.png")'));
    assert.ok(css.includes('url(../fonts/font.woff2)'), 'already-correct relative references are left exactly as written');
    assert.ok(css.includes(`url("${key('xyz.test', '/img/missing.png')}")`), 'failed asset stays absolute');
    assert.ok(css.includes('url(data:image/png;base64,AAAA)'));
    const cdn = fs.readFileSync(r.out(`_assets/cdn.test_${site.port}/lib.css`), 'utf8');
    assert.ok(cdn.includes('url(lib-bg.png)'));
  });

  test('query variants are saved side by side', () => {
    const files = fs.readdirSync(r.out('page'));
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => /^index\.q-id-\d-[0-9a-f]{8}\.html$/.test(f)));
  });

  test('a crawl report records every page and asset with reasons', () => {
    const report = JSON.parse(fs.readFileSync(r.out('crawl-report.json'), 'utf8'));
    assert.equal(report.job.status, 'COMPLETED');
    assert.equal(report.partial, false);
    assert.equal(report.job.entryPage, 'index.html');
    assert.equal(report.pages.length, report.summary.pages.discovered);
    assert.equal(report.assets.length, report.summary.assets.discovered);
    const big = report.assets.find((a) => a.url.endsWith('/img/large-image.png'));
    assert.equal(big.status, 'SKIPPED');
    assert.match(big.reason, /exceeds download.maxFileSizeMb/);
    assert.ok(report.summary.topAssetSkipReasons.some((x) => x.reason_code === 'too-large'));
    assert.equal(report.generator.maintainer, 'Inertia Pixel');
  });

  test('staging data is cleaned up after completion', () => {
    assert.equal(fs.existsSync(path.join(r.job.job_dir, 'staging')), false);
  });
});

describe('configuration variants', () => {
  test('includeSubdomains crawls subdomains but still rejects look-alike domains', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { website: { includeSubdomains: true } } });
    for (const host of ['www.xyz.test', 'crm.xyz.test', 'admin.xyz.test', 'blog.xyz.test']) {
      assert.notEqual(r.page(key(host, '/')).reason_code, 'out-of-scope', host);
    }
    assert.equal(r.page(key('notxyz.test', '/')).reason_code, 'out-of-scope');
    r.store.close();
  });

  test('allowedHosts adds exactly the listed host', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { website: { allowedHosts: ['www.xyz.test'] } } });
    assert.notEqual(r.page(key('www.xyz.test', '/')).reason_code, 'out-of-scope');
    assert.equal(r.page(key('crm.xyz.test', '/')).reason_code, 'out-of-scope');
    r.store.close();
  });

  test('maxDepth and maxPages limit the crawl', async () => {
    const d = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { crawler: { maxDepth: 0, sitemap: { enabled: false } } } });
    assert.equal(d.store.pageCounts(d.job.id).completed, 1);
    assert.equal(d.page(key('xyz.test', '/about')).reason_code, 'max-depth');
    d.store.close();
    const p = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { crawler: { maxPages: 3 } } });
    const counts = p.store.pageCounts(p.job.id);
    assert.ok(counts.completed + counts.failed <= 3, JSON.stringify(counts));
    assert.ok(p.store.topReasons(p.job.id, 'pages', 'SKIPPED', 20).some((x) => x.reason_code === 'max-pages'));
    p.store.close();
  });

  test('external assets can be disabled independently', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { website: { downloadExternalAssets: false } } });
    assert.equal(r.asset(key('cdn.test', '/lib.css')).reason_code, 'out-of-scope');
    const html = fs.readFileSync(r.out('index.html'), 'utf8');
    assert.ok(html.includes(`href="${key('cdn.test', '/lib.css')}"`));
    r.store.close();
  });

  test('crawlExternalPages captures linked external pages without following their links', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { website: { crawlExternalPages: true }, crawler: { maxDepth: 1 } } });
    const cdn = r.page(key('cdn.test', '/'));
    assert.equal(cdn.status, 'COMPLETED');
    assert.equal(cdn.external, 1);
    assert.ok(fs.existsSync(r.out(`_sites/cdn.test_${site.port}/index.html`)));
    r.store.close();
  });

  test('flat output layout groups assets by category', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { output: { preserveStructure: false } } });
    assert.ok(fs.existsSync(r.out('index.html')));
    assert.ok(fs.readdirSync(r.out(`_assets/${site.hostDir}/css`)).some((f) => /^style-[0-9a-f]{8}\.css$/.test(f)));
    assert.ok(fs.readdirSync(r.out(`_assets/${site.hostDir}/images`)).length > 0);
    r.store.close();
  });

  test('separate jobs never overwrite each other', async () => {
    const a = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { crawler: { maxDepth: 0 } } });
    const before = fs.readFileSync(a.out('index.html'), 'utf8');
    const b = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, home: a.home, overrides: { crawler: { maxDepth: 0 }, output: { baseDir: path.dirname(path.dirname(a.job.output_dir)) } } });
    assert.notEqual(a.job.output_dir, b.job.output_dir);
    assert.equal(path.dirname(a.job.output_dir), path.dirname(b.job.output_dir), 'same site directory, different job directories');
    assert.equal(fs.readFileSync(a.out('index.html'), 'utf8'), before);
    a.store.close();
    b.store.close();
  });

  test('resume only re-downloads assets whose files are missing (existingFiles: skip)', async () => {
    const r = await runTestJob({ startUrl: site.start, resolveOverride: site.resolver, overrides: { crawler: { maxDepth: 0 }, output: { keepStaging: true } } });
    const logoHits = hits('xyz.test', '/img/logo.png');
    const bannerHits = hits('xyz.test', '/img/banner.jpg');
    const homeHits = hits('xyz.test', '/');
    fs.rmSync(r.out(`_assets/${site.hostDir}/img/logo.png`));
    r.store.db.prepare("UPDATE jobs SET status = 'STOPPED' WHERE id = ?").run(r.job.id);
    const { token } = prepareResume(r.store, r.job.id, { mode: 'FOREGROUND' });
    const res = await runWorker({ home: r.home, jobId: r.job.id, dispatchToken: token, mode: 'FOREGROUND', handleSignals: false, consoleOutput: false, deps: { resolveOverride: site.resolver } });
    assert.equal(res.status, 'COMPLETED');
    assert.equal(hits('xyz.test', '/img/logo.png'), logoHits + 1, 'missing file downloaded again');
    assert.equal(hits('xyz.test', '/img/banner.jpg'), bannerHits, 'existing file kept');
    assert.equal(hits('xyz.test', '/'), homeHits, 'completed pages are not fetched again');
    assert.ok(fs.existsSync(r.out(`_assets/${site.hostDir}/img/logo.png`)));
    r.store.close();
  });

  test('a start URL that redirects out of scope fails with an actionable message', async () => {
    site.routes['xyz.test/go-www'] = { status: 301, headers: { location: key('www.xyz.test', '/') } };
    const r = await runTestJob({ startUrl: key('xyz.test', '/go-www'), resolveOverride: site.resolver, overrides: { crawler: { sitemap: { enabled: false } } } });
    assert.equal(r.job.status, 'FAILED');
    assert.match(r.job.last_error, /No pages were captured/);
    assert.match(r.job.last_error, /www\.xyz\.test/);
    r.store.close();
  });
});
