import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pageLocalPath, assetLocalPath, sanitizeSegment, safeJoin } from '../../src/output/paths.js';
import { JobStore } from '../../src/jobs/store.js';
import { tempDir } from '../helpers/fixtures.js';

const P = { primaryHost: 'xyz.com', primaryPort: '', preserveStructure: true };
const page = (u) => pageLocalPath(new URL(u), P);

describe('page paths', () => {
  test('preserve the URL hierarchy', () => {
    assert.equal(page('https://xyz.com/'), 'index.html');
    assert.equal(page('https://xyz.com/about'), 'about/index.html');
    assert.equal(page('https://xyz.com/about/'), 'about/index.html');
    assert.equal(page('https://xyz.com/services/web/design'), 'services/web/design/index.html');
    assert.equal(page('https://xyz.com/blog/post.html'), 'blog/post.html');
  });

  test('query variants never overwrite each other', () => {
    const a = page('https://xyz.com/list?page=1');
    const b = page('https://xyz.com/list?page=2');
    assert.notEqual(a, b);
    assert.match(a, /^list\/index\.q-page-1-[0-9a-f]{8}\.html$/);
    assert.notEqual(page('https://xyz.com/list?a=b/c'), page('https://xyz.com/list?a=b_c'));
  });

  test('other allowed hosts and reserved names are separated', () => {
    assert.equal(page('https://www.xyz.com/about'), '_sites/www.xyz.com/about/index.html');
    assert.equal(page('https://xyz.com:8080/'), '_sites/xyz.com_8080/index.html');
    assert.equal(page('https://xyz.com/_assets/x'), '__assets/x/index.html');
  });

  test('flat layout when preserveStructure is false', () => {
    assert.equal(pageLocalPath(new URL('https://xyz.com/'), { ...P, preserveStructure: false, isStart: true }), 'index.html');
    assert.match(pageLocalPath(new URL('https://xyz.com/a/b'), { ...P, preserveStructure: false }), /^_pages\/.+-[0-9a-f]{8}\.html$/);
  });
});

describe('asset paths', () => {
  test('grouped by host, URL path preserved', () => {
    assert.equal(assetLocalPath(new URL('https://xyz.com/css/style.css'), { mime: 'text/css', category: 'stylesheet' }), '_assets/xyz.com/css/style.css');
    assert.equal(assetLocalPath(new URL('https://cdn.example.net/lib/a.js'), { mime: 'text/javascript', category: 'script' }), '_assets/cdn.example.net/lib/a.js');
  });

  test('extensions are fixed from the MIME type', () => {
    assert.equal(assetLocalPath(new URL('https://xyz.com/style.php'), { mime: 'text/css', category: 'stylesheet' }), '_assets/xyz.com/style.php.css');
    assert.equal(assetLocalPath(new URL('https://xyz.com/image'), { mime: 'image/png', category: 'image' }), '_assets/xyz.com/image.png');
    assert.equal(assetLocalPath(new URL('https://xyz.com/img/'), { mime: 'image/jpeg', category: 'image' }), '_assets/xyz.com/img/index.jpg');
    assert.equal(assetLocalPath(new URL('https://xyz.com/blob'), { mime: null, category: 'other' }), '_assets/xyz.com/blob.bin');
  });

  test('query variants get deterministic distinct names', () => {
    const a = assetLocalPath(new URL('https://xyz.com/a.css?v=1'), { mime: 'text/css', category: 'stylesheet' });
    const b = assetLocalPath(new URL('https://xyz.com/a.css?v=2'), { mime: 'text/css', category: 'stylesheet' });
    assert.notEqual(a, b);
    assert.equal(a, assetLocalPath(new URL('https://xyz.com/a.css?v=1'), { mime: 'text/css', category: 'stylesheet' }));
    assert.match(a, /\.css$/);
  });

  test('flat layout groups by category', () => {
    assert.match(assetLocalPath(new URL('https://xyz.com/x/y/logo.png'), { mime: 'image/png', category: 'image', preserveStructure: false }),
      /^_assets\/xyz\.com\/images\/logo-[0-9a-f]{8}\.png$/);
  });
});

describe('path safety', () => {
  test('sanitizes dangerous segments', () => {
    assert.equal(sanitizeSegment('..'), '__');
    assert.equal(sanitizeSegment('.'), '_');
    assert.equal(sanitizeSegment('a:b*c?d"e<f>g|h\\i'), 'a_b_c_d_e_f_g_h_i');
    assert.equal(sanitizeSegment('con'), '_con');
    assert.equal(sanitizeSegment('NUL.txt'), '_NUL.txt');
    assert.equal(sanitizeSegment('trailing. '), 'trailing__');
    assert.ok(Buffer.byteLength(sanitizeSegment('x'.repeat(500))) <= 120);
  });

  test('traversal attempts stay inside the job directory', () => {
    for (const u of [
      'https://xyz.com/../../etc/passwd', 'https://xyz.com/%2e%2e/%2e%2e/etc/passwd', 'https://xyz.com/a/..%2f..%2fetc/passwd',
      'https://xyz.com/%2F..%2F..%2Fsecret', 'https://xyz.com/a\\..\\..\\b',
    ]) {
      const rel = page(u);
      assert.ok(!rel.split('/').includes('..'), `${u} -> ${rel}`);
      const root = '/tmp/job-root';
      assert.ok(safeJoin(root, rel).startsWith(`${root}/`), rel);
      const asset = assetLocalPath(new URL(u), { mime: 'text/plain', category: 'other' });
      assert.ok(!asset.split('/').includes('..'), asset);
    }
  });

  test('safeJoin refuses escapes and absolute paths', () => {
    assert.throws(() => safeJoin('/tmp/root', '../x'), /escapes/);
    assert.throws(() => safeJoin('/tmp/root', '/etc/passwd'), /Unsafe/);
    assert.throws(() => safeJoin('/tmp/root', 'a\0b'), /Unsafe/);
    assert.equal(safeJoin('/tmp/root', 'a/b.html'), path.resolve('/tmp/root/a/b.html'));
  });
});

describe('local path registry', () => {
  const home = tempDir();
  const store = JobStore.open(home);
  store.createJob({ id: 'job_x', start_url: 'https://xyz.com/', hostname: 'xyz.com', mode: 'FOREGROUND', config_json: '{}', output_dir: home, job_dir: home, log_path: path.join(home, 'l') });

  test('case-insensitive collisions get distinct names', () => {
    const a = store.reservePath('job_x', 'asset:1', '_assets/xyz.com/Logo.png');
    const b = store.reservePath('job_x', 'asset:2', '_assets/xyz.com/logo.png');
    assert.equal(a, '_assets/xyz.com/Logo.png');
    assert.notEqual(b.toLowerCase(), a.toLowerCase());
    assert.equal(store.reservePath('job_x', 'asset:1', '_assets/xyz.com/other.png'), a, 'idempotent per owner');
  });

  test('a file can never become a directory of another file (and vice versa)', () => {
    const file = store.reservePath('job_x', 'asset:10', '_assets/xyz.com/api/item');
    const nested = store.reservePath('job_x', 'asset:11', '_assets/xyz.com/api/item/thumb.png');
    assert.equal(file, '_assets/xyz.com/api/item');
    assert.ok(!nested.startsWith('_assets/xyz.com/api/item/'), nested);
    const dirFirst = store.reservePath('job_x', 'asset:12', '_assets/xyz.com/d/e/f.png');
    const fileLater = store.reservePath('job_x', 'asset:13', '_assets/xyz.com/d/e');
    assert.equal(dirFirst, '_assets/xyz.com/d/e/f.png');
    assert.notEqual(fileLater, '_assets/xyz.com/d/e');
  });

  test('cleanup', () => {
    store.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
