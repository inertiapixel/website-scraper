import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPageNormalizer, normalizeAssetUrl, parseHttpUrl, validateStartUrl, redactUrl, isIgnoredReference } from '../../src/url/normalize.js';
import { createScope, isSameOrSubdomain } from '../../src/url/scope.js';
import { createPageRules, patternOf } from '../../src/url/rules.js';
import { loadConfig } from '../../src/config/load.js';

const base = loadConfig();
const crawler = (patch = {}) => ({ ...base.crawler, ...patch, queryParams: { ...base.crawler.queryParams, ...(patch.queryParams || {}) } });
const website = (patch = {}) => ({ ...base.website, ...patch });

describe('URL normalization and deduplication', () => {
  const norm = createPageNormalizer(crawler());

  test('removes fragments, default ports and lowercases the host', () => {
    const a = norm('HTTPS://XYZ.com:443/About#team');
    assert.equal(a.key, 'https://xyz.com/About');
    assert.equal(a.fetchUrl, 'https://xyz.com/About');
  });

  test('treats trailing-slash variants as one page but fetches the first-seen form', () => {
    const a = norm('https://xyz.com/about/');
    const b = norm('https://xyz.com/about');
    assert.equal(a.key, b.key);
    assert.equal(a.fetchUrl, 'https://xyz.com/about/');
    assert.equal(norm('https://xyz.com/').key, 'https://xyz.com/');
  });

  test('keeps trailing slashes distinct when ignoreTrailingSlash is false', () => {
    const strict = createPageNormalizer(crawler({ ignoreTrailingSlash: false }));
    assert.notEqual(strict('https://xyz.com/a/').key, strict('https://xyz.com/a').key);
  });

  test('canonicalizes percent-encoding and dot segments', () => {
    assert.equal(norm('https://xyz.com/a/%7euser/%2fx').key, 'https://xyz.com/a/~user/%2Fx');
    assert.equal(norm('https://xyz.com/a/b/../c/./d').key, 'https://xyz.com/a/c/d');
    assert.equal(norm('https://xyz.com/a/%2e%2e/b').key, 'https://xyz.com/b');
  });

  test('strips tracking parameters and sorts the rest', () => {
    assert.equal(norm('https://xyz.com/p?utm_source=x&b=2&a=1&fbclid=z').key, 'https://xyz.com/p?a=1&b=2');
    assert.equal(norm('https://xyz.com/p?utm_medium=x').key, 'https://xyz.com/p');
  });

  test('query modes: drop and allowlist', () => {
    const drop = createPageNormalizer(crawler({ queryParams: { mode: 'drop' } }));
    assert.equal(drop('https://xyz.com/p?a=1').key, 'https://xyz.com/p');
    const allow = createPageNormalizer(crawler({ queryParams: { mode: 'allowlist', allow: ['page'] } }));
    assert.equal(allow('https://xyz.com/p?page=2&sort=asc').key, 'https://xyz.com/p?page=2');
  });

  test('resolves relative links against a base', () => {
    assert.equal(norm('../c', 'https://xyz.com/a/b/').key, 'https://xyz.com/a/c');
    assert.equal(norm('?q=1', 'https://xyz.com/s').key, 'https://xyz.com/s?q=1');
  });

  test('rejects non-HTTP protocols and credentials', () => {
    for (const u of ['ftp://xyz.com/', 'javascript:alert(1)', 'mailto:a@b.c', 'file:///etc/passwd', 'data:text/html,x']) {
      assert.equal(norm(u).ok, false, u);
    }
    assert.equal(parseHttpUrl('https://user:pw@xyz.com/').code, 'credentials-in-url');
    assert.equal(isIgnoredReference('#top'), true);
    assert.equal(isIgnoredReference('tel:+123'), true);
    assert.equal(isIgnoredReference('/about'), false);
  });

  test('asset URLs keep the query verbatim', () => {
    assert.equal(normalizeAssetUrl('https://cdn.com/a.css?v=2&a=1#x').key, 'https://cdn.com/a.css?v=2&a=1');
  });

  test('validates the starting URL with clear errors', () => {
    assert.throws(() => validateStartUrl(''), /starting URL is required/);
    assert.throws(() => validateStartUrl('xyz.com'), /must start with http/);
    assert.throws(() => validateStartUrl('ftp://xyz.com'), /must start with http/);
    assert.throws(() => validateStartUrl('https://'), /Invalid starting URL/);
    assert.equal(validateStartUrl('https://XYZ.com.').hostname, 'xyz.com');
  });

  test('redacts secrets in URLs', () => {
    const r = redactUrl('https://u:p@xyz.com/a?token=abc&page=2&X-Amz-Signature=sig');
    assert.ok(!r.includes('abc') && !r.includes('sig') && !r.includes('u:p'));
    assert.ok(r.includes('page=2'));
  });
});

describe('domain scope', () => {
  const start = new URL('https://xyz.com');
  const scope = createScope(website(), start);

  test('default: exact hostname only (table from the requirements)', () => {
    const expected = {
      'xyz.com': 'internal',
      'www.xyz.com': 'excluded',
      'crm.xyz.com': 'excluded',
      'admin.xyz.com': 'excluded',
      'blog.xyz.com': 'excluded',
      'otherdomain.com': 'excluded',
    };
    for (const [host, s] of Object.entries(expected)) assert.equal(scope.classifyPageHost(host).scope, s, host);
    for (const p of ['/', '/about', '/services']) assert.equal(scope.isInternalHost(new URL(p, start).hostname), true);
  });

  test('rejects deceptive look-alike domains', () => {
    for (const host of ['notxyz.com', 'xyz.com.evil.net', 'xyz.co', 'xyzcom', 'evil-xyz.com', 'xyz.com-evil.net']) {
      assert.equal(scope.isInternalHost(host), false, host);
    }
  });

  test('www is a subdomain and is only crawled when explicitly allowed', () => {
    assert.equal(scope.isInternalHost('www.xyz.com'), false);
    const s = createScope(website({ allowedHosts: ['www.xyz.com'] }), start);
    assert.equal(s.isInternalHost('www.xyz.com'), true);
    assert.equal(s.isInternalHost('crm.xyz.com'), false);
  });

  test('includeSubdomains allows the root and true subdomains only', () => {
    const s = createScope(website({ includeSubdomains: true }), start);
    for (const h of ['xyz.com', 'www.xyz.com', 'crm.xyz.com', 'a.b.xyz.com']) assert.equal(s.isInternalHost(h), true, h);
    for (const h of ['notxyz.com', 'xyz.com.evil.net', 'evilxyz.com']) assert.equal(s.isInternalHost(h), false, h);
  });

  test('excludedHosts wins over everything, wildcard patterns supported', () => {
    const s = createScope(website({ includeSubdomains: true, excludedHosts: ['admin.xyz.com'], allowedHosts: ['*.partner.com'] }), start);
    assert.equal(s.isInternalHost('admin.xyz.com'), false);
    assert.equal(s.isInternalHost('a.partner.com'), true);
    assert.equal(s.isInternalHost('partner.com'), false);
  });

  test('external pages only when crawlExternalPages is enabled', () => {
    assert.equal(scope.classifyPageHost('otherdomain.com').scope, 'excluded');
    const s = createScope(website({ crawlExternalPages: true }), start);
    assert.equal(s.classifyPageHost('otherdomain.com').scope, 'external');
  });

  test('external assets are a separate permission from external pages', () => {
    assert.equal(scope.checkAssetHost('cdn.example.net').allowed, true);
    assert.equal(scope.classifyPageHost('cdn.example.net').scope, 'excluded');
    const noExt = createScope(website({ downloadExternalAssets: false }), start);
    assert.equal(noExt.checkAssetHost('cdn.example.net').allowed, false);
    assert.equal(noExt.checkAssetHost('xyz.com').allowed, true);
    const limited = createScope(website({ externalAssetHosts: ['fonts.gstatic.com'] }), start);
    assert.equal(limited.checkAssetHost('fonts.gstatic.com').allowed, true);
    assert.equal(limited.checkAssetHost('cdn.example.net').allowed, false);
  });

  test('isSameOrSubdomain never matches across label boundaries or IPs', () => {
    assert.equal(isSameOrSubdomain('a.xyz.com', 'xyz.com'), true);
    assert.equal(isSameOrSubdomain('axyz.com', 'xyz.com'), false);
    assert.equal(isSameOrSubdomain('1.127.0.0.1', '127.0.0.1'), false);
  });
});

describe('path rules and crawl traps', () => {
  test('include and exclude paths', () => {
    const rules = createPageRules(crawler({ includePaths: ['/blog'], excludePaths: ['/blog/drafts', 're:\\.php$'] }));
    assert.equal(rules.check(new URL('https://x.com/blog/post')), null);
    assert.equal(rules.check(new URL('https://x.com/blog')), null);
    assert.equal(rules.check(new URL('https://x.com/blogger'))?.code, 'not-included-path');
    assert.equal(rules.check(new URL('https://x.com/blog/drafts/1'))?.code, 'excluded-path');
    assert.equal(rules.check(new URL('https://x.com/blog/a.php'))?.code, 'excluded-path');
    assert.equal(rules.check(new URL('https://x.com/'), { isStart: true }), null, 'start page is exempt from includePaths');
  });

  test('glob patterns', () => {
    const rules = createPageRules(crawler({ excludePaths: ['/tag/*', '/archive/**/print'] }));
    assert.equal(rules.check(new URL('https://x.com/tag/a'))?.code, 'excluded-path');
    assert.equal(rules.check(new URL('https://x.com/tag/a/b')), null);
    assert.equal(rules.check(new URL('https://x.com/archive/2020/01/print'))?.code, 'excluded-path');
  });

  test('trap heuristics: length, depth and repeated segments', () => {
    const rules = createPageRules(crawler());
    assert.equal(rules.check(new URL(`https://x.com/${'a'.repeat(3000)}`))?.code, 'trap-url-length');
    assert.equal(rules.check(new URL(`https://x.com${'/s'.repeat(1).concat(Array.from({ length: 25 }, (_, i) => `/p${i}`).join(''))}`))?.code, 'trap-path-depth');
    assert.equal(rules.check(new URL('https://x.com/a/b/a/b/a/b/a/b'))?.code, 'trap-repeated-segment');
    assert.equal(rules.check(new URL('https://x.com/a/b/a/b')), null);
  });

  test('numeric segments share a pattern (calendar/pagination traps)', () => {
    assert.equal(patternOf(new URL('https://x.com/cal/2024/01')), patternOf(new URL('https://x.com/cal/2031/12')));
    assert.notEqual(patternOf(new URL('https://x.com/p/1-red')), patternOf(new URL('https://x.com/p/1-blue')));
  });
});
