import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findCssReferences, rewriteCss, cssReferenceHint } from '../../src/content/css.js';
import { extractReferences, rewriteHtml, relativeHref } from '../../src/content/html.js';
import { parseSrcset, serializeSrcset } from '../../src/content/srcset.js';
import { decodeHtml, decodeCssBuffer } from '../../src/content/encoding.js';

describe('CSS dependency extraction', () => {
  const css = `@charset "utf-8";
@import "base.css";
@import url(theme.css) screen;
/* url(commented.png) @import "nope.css"; */
.a{background:url( 'a b.png' )}
.b{background:url(b.png?v=1#frag)}
.c{content:"url(not-a-ref.png)"}
@font-face{font-family:X;src:url(f.woff2) format("woff2"), url("f.woff") format("woff")}
.d{background-image:image-set("d.png" 1x, url(d2.png) 2x)}
.e{background:url(data:image/png;base64,AAAA)}
.f{mask:url(#mask)}
.g{background:url(\\67 .png)}`;
  const refs = findCssReferences(css);

  test('finds url(), @import and image-set references, skipping comments and strings', () => {
    const values = refs.map((r) => r.value);
    assert.deepEqual(values, ['base.css', 'theme.css', 'a b.png', 'b.png?v=1#frag', 'f.woff2', 'f.woff', 'd.png', 'd2.png', 'data:image/png;base64,AAAA', '#mask', 'g.png']);
    assert.ok(!values.includes('commented.png') && !values.includes('nope.css') && !values.includes('not-a-ref.png'));
  });

  test('classifies imports and fonts', () => {
    const byValue = Object.fromEntries(refs.map((r) => [r.value, r]));
    assert.equal(cssReferenceHint(byValue['base.css'], 'https://x.com/base.css'), 'stylesheet');
    assert.equal(cssReferenceHint(byValue['theme.css'], 'https://x.com/theme.css'), 'stylesheet');
    assert.equal(byValue['f.woff2'].context, 'font');
    assert.equal(cssReferenceHint({ type: 'url', context: 'font' }, 'https://x.com/font-file'), 'font');
    assert.equal(cssReferenceHint(byValue['a b.png'], 'https://x.com/a%20b.png'), 'image');
  });

  test('rewrites only references the mapper returns, preserving everything else', () => {
    const map = { 'base.css': 'local/base.css', 'a b.png': 'img/a%20b.png', 'f.woff2': '../fonts/f.woff2', 'd.png': 'd-local.png' };
    const out = rewriteCss(css, (r) => map[r.value] ?? null);
    assert.ok(out.includes('@import "local/base.css";'));
    assert.ok(out.includes('url("img/a%20b.png")'));
    assert.ok(out.includes('url("../fonts/f.woff2") format("woff2")'));
    assert.ok(out.includes('image-set("d-local.png" 1x, url(d2.png) 2x)'));
    assert.ok(out.includes('/* url(commented.png) @import "nope.css"; */'));
    assert.ok(out.includes('url(data:image/png;base64,AAAA)'));
    assert.ok(out.includes('url(#mask)'));
  });

  test('escapes quotes in replacement URLs', () => {
    assert.equal(rewriteCss('a{b:url(x)}', () => 'q"r'), 'a{b:url("q\\"r")}');
  });

  test('decodes UTF-8 and falls back to latin1 for other encodings', () => {
    assert.equal(decodeCssBuffer(Buffer.from('a{content:"é"}')).encoding, 'utf8');
    assert.equal(decodeCssBuffer(Buffer.from([0x61, 0xe9, 0x62])).encoding, 'latin1');
  });
});

describe('srcset', () => {
  test('parses and serializes candidates', () => {
    const list = parseSrcset('a.png 1x, b.png 2x,c.png 100w, d.png');
    assert.deepEqual(list.map((c) => c.url), ['a.png', 'b.png', 'c.png', 'd.png']);
    assert.equal(serializeSrcset(list), 'a.png 1x, b.png 2x, c.png 100w, d.png');
  });
});

describe('HTML asset discovery and rewriting', () => {
  const page = 'https://xyz.com/blog/post';
  const doc = `<!doctype html><html><head>
    <meta charset="windows-1252"><meta http-equiv="Content-Security-Policy" content="default-src 'self'">
    <link rel="stylesheet" href="/css/site.css" integrity="sha384-x" crossorigin="anonymous">
    <link rel="icon" href="/favicon.ico"><link rel="preload" as="font" href="/f.woff2"><link rel="canonical" href="/blog/post">
    <link rel="preconnect" href="https://fonts.example.com">
    <style>.hero{background:url(/img/hero.jpg)} @import "/css/extra.css";</style>
    <script src="/js/app.js"></script>
  </head><body>
    <a href="/">Home</a> <a href="../about#team">About</a> <a href="#top">Top</a> <a href="mailto:x@y.z">Mail</a>
    <a href="https://external.com/page">Ext</a> <a href="/not-captured">Missing page</a> <a href="/files/doc.pdf">PDF</a>
    <img src="/img/a.png" srcset="/img/a.png 1x, /img/a@2x.png 2x" alt="a">
    <img src="data:image/gif;base64,R0lGOD" data-src="/img/lazy.png" alt="lazy">
    <img src="/img/failed.png"> <img src="blob:https://xyz.com/1234">
    <picture><source srcset="/img/p.webp" type="image/webp"><img src="/img/p.jpg"></picture>
    <video poster="/img/poster.png"><source src="/v/movie.mp4"></video>
    <div style="background:url('/img/bg.png')"></div>
    <svg><use href="/icons.svg#home"></use></svg>
    <noscript><img src="/img/noscript.png"></noscript>
    <iframe src="/embed"></iframe>
  </body></html>`;

  test('extracts links and assets from all common sources', () => {
    const { links, assets } = extractReferences(doc, page);
    assert.ok(links.includes('https://xyz.com/'));
    assert.ok(links.includes('https://xyz.com/about#team'));
    assert.ok(links.includes('https://xyz.com/embed'));
    assert.ok(!links.some((l) => l.startsWith('mailto:')));
    const urls = assets.map((a) => a.url);
    for (const p of ['/css/site.css', '/favicon.ico', '/f.woff2', '/img/hero.jpg', '/css/extra.css', '/js/app.js', '/img/a.png', '/img/a@2x.png',
      '/img/lazy.png', '/img/p.webp', '/img/p.jpg', '/img/poster.png', '/v/movie.mp4', '/img/bg.png', '/icons.svg#home', '/img/noscript.png']) {
      assert.ok(urls.includes(`https://xyz.com${p}`), p);
    }
    assert.ok(!urls.some((x) => x.startsWith('data:') || x.startsWith('blob:')));
    assert.equal(assets.find((a) => a.url.endsWith('/v/movie.mp4')).hint, 'video');
    assert.equal(assets.find((a) => a.url.endsWith('/f.woff2')).hint, 'font');
  });

  test('rewrites captured references to relative paths and leaves the rest absolute', () => {
    const assets = {
      'https://xyz.com/css/site.css': '_assets/xyz.com/css/site.css',
      'https://xyz.com/img/a.png': '_assets/xyz.com/img/a.png',
      'https://xyz.com/img/a@2x.png': '_assets/xyz.com/img/a@2x.png',
      'https://xyz.com/img/lazy.png': '_assets/xyz.com/img/lazy.png',
      'https://xyz.com/img/hero.jpg': '_assets/xyz.com/img/hero.jpg',
      'https://xyz.com/img/bg.png': '_assets/xyz.com/img/bg.png',
      'https://xyz.com/icons.svg': '_assets/xyz.com/icons.svg',
      'https://xyz.com/files/doc.pdf': '_assets/xyz.com/files/doc.pdf',
    };
    const pages = { 'https://xyz.com/': 'index.html', 'https://xyz.com/about': 'about/index.html', 'https://xyz.com/blog/post': 'blog/post/index.html' };
    const strip = (u) => { const c = new URL(u); c.hash = ''; return c.href; };
    const { html } = rewriteHtml(doc, {
      pageUrl: page,
      localPath: 'blog/post/index.html',
      resolvePage: (u) => pages[strip(u)] ?? assets[strip(u)] ?? null,
      resolveAsset: (u) => assets[strip(u)] ?? null,
    });
    assert.ok(html.includes('href="../../_assets/xyz.com/css/site.css"'));
    assert.ok(!html.includes('integrity='), 'SRI removed from localized assets');
    assert.ok(html.includes('href="../../index.html"'));
    assert.ok(html.includes('href="../../about/index.html#team"'));
    assert.ok(html.includes('href="#top"'));
    assert.ok(html.includes('href="mailto:x@y.z"'));
    assert.ok(html.includes('href="https://external.com/page"'));
    assert.ok(html.includes('href="https://xyz.com/not-captured"'), 'uncaptured page stays absolute');
    assert.ok(html.includes('href="../../_assets/xyz.com/files/doc.pdf"'), 'file links point to the downloaded copy');
    assert.ok(html.includes('src="https://xyz.com/img/failed.png"'), 'failed asset is not rewritten to a local path');
    assert.ok(html.includes('srcset="../../_assets/xyz.com/img/a.png 1x, ../../_assets/xyz.com/img/a%402x.png 2x"'));
    assert.ok(html.includes('src="../../_assets/xyz.com/img/lazy.png"'), 'lazy data-src promoted');
    assert.ok(html.includes('src="blob:https://xyz.com/1234"'));
    assert.ok(html.includes('url(&quot;../../_assets/xyz.com/img/bg.png&quot;)'));
    assert.ok(html.includes('url("../../_assets/xyz.com/img/hero.jpg")'));
    assert.ok(html.includes('href="../../_assets/xyz.com/icons.svg#home"'));
    assert.ok(html.includes('href="https://xyz.com/blog/post"'), 'canonical made absolute');
    assert.ok(html.includes('<meta charset="utf-8">') && !html.includes('windows-1252'));
    assert.ok(!html.includes('Content-Security-Policy'));
  });

  test('honours <base href> and removes it', () => {
    const { html } = rewriteHtml('<html><head><base href="https://cdn.xyz.com/root/"></head><body><img src="a.png"></body></html>', {
      pageUrl: 'https://xyz.com/', localPath: 'index.html',
      resolvePage: () => null,
      resolveAsset: (u) => (u.href === 'https://cdn.xyz.com/root/a.png' ? '_assets/cdn.xyz.com/root/a.png' : null),
    });
    assert.ok(html.includes('src="_assets/cdn.xyz.com/root/a.png"'));
    assert.ok(!html.includes('<base'));
  });

  test('removeScripts strips executable scripts but keeps JSON data', () => {
    const { html } = rewriteHtml('<html><head><script src="/a.js"></script><script type="application/ld+json">{}</script></head><body><script>alert(1)</script></body></html>', {
      pageUrl: 'https://xyz.com/', localPath: 'index.html', resolvePage: () => null, resolveAsset: () => null, removeScripts: true,
    });
    assert.ok(!html.includes('a.js') && !html.includes('alert(1)'));
    assert.ok(html.includes('application/ld+json'));
  });

  test('relative paths are percent-encoded', () => {
    assert.equal(relativeHref('a/b/index.html', '_assets/h/x y#.png'), '../../_assets/h/x%20y%23.png');
    assert.equal(relativeHref('index.html', 'index.html'), 'index.html');
  });

  test('decodes legacy charsets', () => {
    assert.equal(decodeHtml(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'windows-1252'), 'café');
    assert.equal(decodeHtml(Buffer.from('<meta charset="iso-8859-1">\xe9', 'latin1')).endsWith('é'), true);
  });
});
