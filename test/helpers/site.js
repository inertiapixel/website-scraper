/**
 * Multi-host fixture website used by the crawl integration tests.
 *   xyz.test              the site being captured
 *   www/crm/admin/blog.xyz.test, notxyz.test, otherdomain.test, evil.test
 *                         hosts that must never be crawled by default
 *   cdn.test              external asset host (assets only, never pages)
 */
import { startServer, siteHandler, html, bytes, loopbackResolver, SIGNATURES } from './fixtures.js';

export const HOSTS = [
  'xyz.test', 'www.xyz.test', 'crm.xyz.test', 'admin.xyz.test', 'blog.xyz.test', 'notxyz.test',
  'otherdomain.test', 'evil.test', 'cdn.test',
];

const png = (extra = 64) => Buffer.concat([SIGNATURES.png, bytes(extra)]);

export async function startXyzSite({ pageDelayMs = 0, extraPages = 0 } = {}) {
  let port = 0;
  const u = (host, p) => `http://${host}:${port}${p}`;
  const routes = {};
  const server = await startServer((req, res, ctx) => siteHandler(routes)(req, res, ctx));
  port = server.port;

  const extraLinks = Array.from({ length: extraPages }, (_, i) => `<a href="/extra/${i}">extra ${i}</a>`).join('');
  Object.assign(routes, {
    'xyz.test/': {
      delay: pageDelayMs,
      body: html(`
        <a href="/about">About</a> <a href="/about/">About (slash)</a> <a href="/about#team">Team</a>
        <a href="/services">Services</a> <a href="/?utm_source=newsletter">Home (tracking)</a>
        <a href="${u('www.xyz.test', '/')}">www</a> <a href="${u('crm.xyz.test', '/')}">crm</a>
        <a href="${u('admin.xyz.test', '/')}">admin</a> <a href="${u('blog.xyz.test', '/')}">blog</a>
        <a href="${u('notxyz.test', '/')}">deceptive</a> <a href="${u('otherdomain.test', '/')}">other</a>
        <a href="${u('cdn.test', '/')}">cdn home</a>
        <a href="mailto:hello@xyz.test">mail</a> <a href="javascript:void(0)">js</a> <a href="#top">top</a>
        <a href="/page?id=1">p1</a> <a href="/page?id=2">p2</a> <a href="/files/brochure.pdf">pdf</a>
        <a href="/redirect-out">out</a> <a href="/redirect-in">in</a> <a href="/private/secret">private</a>
        <a href="/missing">missing</a>
        ${extraLinks}
        <img src="/img/logo.png" srcset="/img/logo.png 1x, /img/logo@2x.png 2x" alt="logo">
        <img src="/img/banner.jpg"> <img src="/img/large-image.png"> <img src="/img/chunked-large.png">
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="inline">
        <video src="/media/video.mp4" poster="/img/poster.png"></video>
        <audio src="/media/audio.mp3"></audio>
        <img src="/files/unknown-file">
        <div style="background-image: url('/img/bg-inline.png')">x</div>
        <script src="/js/app.js"></script>`,
      `<link rel="stylesheet" href="/css/style.css">
       <link rel="stylesheet" href="${u('cdn.test', '/lib.css')}">
       <link rel="icon" href="/favicon.ico">
       <style>@import url("/css/print.css"); .hero{background:url(/img/hero.png)}</style>`),
    },
    'xyz.test/about': { delay: pageDelayMs, body: html('<h1>About</h1><a href="/services">Services</a><a href="/">Home</a><img src="/img/logo.png">') },
    'xyz.test/services': { delay: pageDelayMs, body: html('<a href="/services/team">Team</a>') },
    'xyz.test/services/team': { delay: pageDelayMs, body: html('<p>team</p><a href="../">up</a><a href="/about">about</a>') },
    'xyz.test/page?id=1': { body: html('<p>one</p>') },
    'xyz.test/page?id=2': { body: html('<p>two</p>') },
    'xyz.test/sitemap-only': { body: html('<p>only in sitemap</p>') },
    'xyz.test/private/secret': { body: html('<p>secret</p>') },
    'xyz.test/redirect-out': { status: 302, headers: { location: u('evil.test', '/') } },
    'xyz.test/redirect-in': { status: 301, headers: { location: '/services/team' } },
    'xyz.test/robots.txt': {
      type: 'text/plain',
      body: `User-agent: *\nDisallow: /private\n\nSitemap: ${u('xyz.test', '/sitemap.xml')}\nSitemap: ${u('evil.test', '/sitemap.xml')}\n`,
    },
    'xyz.test/sitemap.xml': {
      type: 'application/xml',
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${u('xyz.test', '/sitemap-only')}</loc></url>
        <url><loc>${u('www.xyz.test', '/not-me')}</loc></url>
      </urlset>`,
    },
    'xyz.test/css/style.css': {
      type: 'text/css',
      body: '@import "base.css";\nbody{background:url("../img/bg.png")}\n/* url(/img/commented.png) */\n' +
        '@font-face{font-family:F;src:url(../fonts/font.woff2) format("woff2")}\n' +
        '.x{background:url(data:image/png;base64,AAAA)}\n.missing{background:url(/img/missing.png)}\n',
    },
    'xyz.test/css/base.css': { type: 'text/css', body: 'h1{color:red}' },
    'xyz.test/css/print.css': { type: 'text/css', body: '@media print{body{color:#000}}' },
    'xyz.test/fonts/font.woff2': { type: 'font/woff2', body: Buffer.concat([Buffer.from('wOF2'), bytes(200)]) },
    'xyz.test/img/logo.png': { type: 'image/png', body: png() },
    'xyz.test/img/logo@2x.png': { type: 'image/png', body: png(128) },
    'xyz.test/img/poster.png': { type: 'image/png', body: png() },
    'xyz.test/img/bg.png': { type: 'image/png', body: png() },
    'xyz.test/img/bg-inline.png': { type: 'image/png', body: png() },
    'xyz.test/img/hero.png': { type: 'image/png', body: png() },
    'xyz.test/img/banner.jpg': { type: 'image/jpeg', body: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), bytes(900 * 1024)]) },
    'xyz.test/img/large-image.png': { type: 'image/png', body: png(2 * 1024 * 1024) },
    'xyz.test/img/chunked-large.png': (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      let sent = 0;
      const tick = () => {
        if (sent >= 2 * 1024 * 1024 || res.destroyed) return res.end();
        sent += 64 * 1024;
        if (res.write(bytes(64 * 1024))) setImmediate(tick);
        else res.once('drain', tick);
      };
      tick();
    },
    'xyz.test/media/video.mp4': { type: 'video/mp4', body: SIGNATURES.mp4 },
    'xyz.test/media/audio.mp3': { type: 'audio/mpeg', body: SIGNATURES.mp3 },
    'xyz.test/files/unknown-file': { type: 'video/mp4', body: Buffer.concat([SIGNATURES.mp4, bytes(500 * 1024)]) },
    'xyz.test/files/brochure.pdf': { type: 'application/pdf', body: Buffer.concat([Buffer.from('%PDF-1.4\n'), bytes(100)]) },
    'xyz.test/favicon.ico': { type: 'image/x-icon', body: Buffer.from([0, 0, 1, 0, 1, 0]) },
    'xyz.test/js/app.js': { type: 'text/javascript', body: 'console.log("app")' },
    'cdn.test/lib.css': { type: 'text/css', body: '.lib{background:url(lib-bg.png)}' },
    'cdn.test/lib-bg.png': { type: 'image/png', body: png() },
    'cdn.test/': { body: html('<p>cdn home page - must never be crawled</p>') },
  });
  for (let i = 0; i < extraPages; i++) {
    routes[`xyz.test/extra/${i}`] = { delay: pageDelayMs, body: html(`<p>extra ${i}</p><img src="/img/logo.png">`) };
  }

  return {
    server,
    port,
    routes,
    u,
    start: u('xyz.test', '/'),
    resolver: loopbackResolver(HOSTS),
    hostDir: `xyz.test_${port}`,
    close: () => server.close(),
  };
}
