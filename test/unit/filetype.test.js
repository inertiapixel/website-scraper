import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { categoryFromMime, extensionOf, mimeMatches, sniff, looksLikePage, extensionCompatible } from '../../src/content/filetype.js';
import { createAssetFilter } from '../../src/crawl/asset-filter.js';
import { createScope } from '../../src/url/scope.js';
import { loadConfig } from '../../src/config/load.js';
import { SkipError } from '../../src/util/errors.js';
import { SIGNATURES } from '../helpers/fixtures.js';

const config = loadConfig();
const filter = createAssetFilter(config, createScope(config.website, new URL('https://xyz.com')));
const u = (s) => new URL(s, 'https://xyz.com');

describe('extension filtering', () => {
  test('default video and audio extensions are excluded before any request', () => {
    for (const ext of ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.wma']) {
      assert.equal(filter.beforeRequest(u(`/media/file${ext}`), 'other')?.code, 'excluded-extension', ext);
      assert.equal(filter.beforeRequest(u(`/media/FILE${ext.toUpperCase()}?x=1`), 'other')?.code, 'excluded-extension', `${ext} uppercase`);
    }
  });

  test('regular assets pass the pre-request check', () => {
    for (const p of ['/style.css', '/logo.png', '/banner.jpg', '/app.js', '/font.woff2', '/doc.pdf', '/x']) {
      assert.equal(filter.beforeRequest(u(p), 'image'), null, p);
    }
  });

  test('context category from <video>/<audio> elements is excluded even without an extension', () => {
    assert.equal(filter.beforeRequest(u('/stream'), 'video')?.code, 'excluded-category');
    assert.equal(filter.beforeRequest(u('/stream'), 'audio')?.code, 'excluded-category');
  });

  test('excluded URL patterns and CSS depth', () => {
    const c = loadConfig({ overrides: { download: { excludedUrlPatterns: ['https://xyz.com/ads/**', 're:tracking'] } } });
    const f = createAssetFilter(c, createScope(c.website, new URL('https://xyz.com')));
    assert.equal(f.beforeRequest(u('/ads/banner.png'), 'image')?.code, 'excluded-url-pattern');
    assert.equal(f.beforeRequest(u('/img/tracking-pixel.gif'), 'image')?.code, 'excluded-url-pattern');
    assert.equal(f.beforeRequest(u('/img/a.png'), 'image', 99)?.code, 'css-depth');
  });

  test('extension helpers', () => {
    assert.equal(extensionOf('/a/b/File.PNG'), '.png');
    assert.equal(extensionOf('/a/b/'), '');
    assert.equal(extensionOf('/a/v1.2/'), '');
    assert.equal(looksLikePage(u('/about')), true);
    assert.equal(looksLikePage(u('/index.php')), true);
    assert.equal(looksLikePage(u('/doc.pdf')), false);
    assert.equal(extensionCompatible('.php', 'text/css'), false);
    assert.equal(extensionCompatible('.css', 'text/css'), true);
  });
});

describe('MIME filtering', () => {
  const info = (mime, finalUrl = 'https://xyz.com/x') => ({ mime, finalUrl });

  test('video/* and audio/* are excluded regardless of extension', () => {
    for (const [mime, path] of [['video/mp4', '/unknown-file'], ['video/webm', '/image.png'], ['audio/mpeg', '/song'], ['audio/ogg', '/x.css']]) {
      assert.throws(() => filter.afterHeaders(info(mime, `https://xyz.com${path}`), 'image', `https://xyz.com${path}`),
        (e) => e instanceof SkipError && e.reasonCode === 'excluded-mime', `${mime} ${path}`);
    }
  });

  test('allowed types return their category', () => {
    assert.equal(filter.afterHeaders(info('text/css'), 'stylesheet', 'https://xyz.com/x'), 'stylesheet');
    assert.equal(filter.afterHeaders(info('image/png'), 'image', 'https://xyz.com/x'), 'image');
    assert.equal(filter.afterHeaders(info(null, 'https://xyz.com/a.woff2'), 'font', 'https://xyz.com/a.woff2'), 'font');
  });

  test('HTML served where an image was expected is skipped', () => {
    assert.throws(() => filter.afterHeaders(info('text/html'), 'image', 'https://xyz.com/x'), (e) => e.reasonCode === 'unexpected-html');
  });

  test('magic-byte sniffing catches media with generic or missing MIME types', () => {
    assert.throws(() => filter.afterFirstBytes(SIGNATURES.mp4, { mime: 'application/octet-stream' }), (e) => e.reasonCode === 'excluded-mime');
    assert.throws(() => filter.afterFirstBytes(SIGNATURES.mp3, { mime: null }), (e) => e.reasonCode === 'excluded-mime');
    assert.throws(() => filter.afterFirstBytes(SIGNATURES.mp4, { mime: 'image/png' }), (e) => e.reasonCode === 'excluded-mime');
    assert.equal(filter.afterFirstBytes(SIGNATURES.png, { mime: null }).mime, 'image/png');
  });

  test('mime helpers', () => {
    assert.equal(mimeMatches('video/mp4', ['video/*']), true);
    assert.equal(mimeMatches('image/png', ['video/*', 'audio/*']), false);
    assert.equal(categoryFromMime('application/javascript'), 'script');
    assert.equal(categoryFromMime('font/woff2'), 'font');
    assert.equal(categoryFromMime('application/octet-stream'), null);
    assert.equal(sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(4)])).category, 'image');
    assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime, 'image/svg+xml');
  });
});
