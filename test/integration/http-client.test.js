import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HttpClient } from '../../src/net/http-client.js';
import {
  SizeLimitError, RedirectScopeError, TooManyRedirectsError, BlockedRequestError, TimeoutError, AbortedError, HttpStatusError, isRetryable,
} from '../../src/util/errors.js';
import { startServer, startRawServer, bytes, tempDir } from '../helpers/fixtures.js';

const MB = 1024 * 1024;
const dir = tempDir('ws-http-');
const target = (name) => path.join(dir, `${name}-${Math.random().toString(16).slice(2)}.part`);
const client = new HttpClient({ userAgent: 'test', allowPrivateNetworks: true });

let server;
let raw;
before(async () => {
  server = await startServer((req, res) => {
    const p = req.url;
    if (p === '/small') return res.end(bytes(120 * 1024));
    if (p === '/declared-large') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(2 * MB) });
      return res.end(bytes(2 * MB));
    }
    if (p === '/chunked-large') {
      res.writeHead(200, { 'content-type': 'image/png' }); // no Content-Length: chunked
      let sent = 0;
      const pump = () => {
        while (sent < 3 * MB) {
          sent += 64 * 1024;
          if (!res.write(bytes(64 * 1024))) return res.once('drain', pump);
        }
        return res.end();
      };
      return pump();
    }
    if (p === '/gzip') {
      const body = zlib.gzipSync(Buffer.from('hello compressed world'));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) });
      return res.end(body);
    }
    if (p === '/br') {
      res.writeHead(200, { 'content-encoding': 'br' });
      return res.end(zlib.brotliCompressSync(Buffer.from('brotli body')));
    }
    if (p === '/gzip-bomb') {
      const body = zlib.gzipSync(Buffer.alloc(3 * MB));
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) });
      return res.end(body);
    }
    if (p === '/redirect-out') {
      res.writeHead(302, { location: 'http://evil.test/x' });
      return res.end();
    }
    if (p.startsWith('/loop')) {
      res.writeHead(302, { location: `/loop${Number(p.slice(5) || 0) + 1}` });
      return res.end();
    }
    if (p === '/slow') return setTimeout(() => res.end('late'), 3000);
    if (p === '/503') {
      res.writeHead(503, { 'retry-after': '2' });
      return res.end();
    }
    res.writeHead(404);
    return res.end();
  });
  raw = await startRawServer((socket, p) => {
    if (p === '/http10-large') {
      // HTTP/1.0, no Content-Length: body is delimited by connection close.
      socket.write('HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n');
      const chunk = bytes(256 * 1024);
      let n = 0;
      const pump = () => {
        while (n++ < 12) if (!socket.write(chunk)) return socket.once('drain', pump);
        return socket.end();
      };
      return pump();
    }
    if (p === '/lying-short') {
      // Declares 5000 bytes, sends 100, then closes.
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n');
      socket.end(bytes(100));
      return undefined;
    }
    if (p === '/lying-long') {
      // Declares 100 bytes but sends far more: only the declared body is accepted.
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n');
      socket.end(bytes(3 * MB));
      return undefined;
    }
    socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    return undefined;
  });
});
after(async () => {
  client.close();
  await server.close();
  await raw.close();
});

describe('streamed size enforcement', () => {
  test('files under the limit are downloaded', async () => {
    const f = target('small');
    const res = await client.download(server.url('/small'), f, { maxBytes: MB });
    assert.equal(res.bytes, 120 * 1024);
    assert.equal(fs.statSync(f).size, 120 * 1024);
  });

  test('a declared Content-Length above the limit is rejected before any body is written', async () => {
    const f = target('declared');
    await assert.rejects(client.download(server.url('/declared-large'), f, { maxBytes: MB }), (e) => e instanceof SizeLimitError && e.declared === 2 * MB);
    assert.equal(fs.existsSync(f), false);
  });

  test('chunked responses without Content-Length are cut off while streaming and the partial file removed', async () => {
    const f = target('chunked');
    await assert.rejects(client.download(server.url('/chunked-large'), f, { maxBytes: MB }), (e) => e instanceof SizeLimitError && e.received > MB);
    assert.equal(fs.existsSync(f), false, 'partial file cleaned up');
  });

  test('close-delimited HTTP/1.0 bodies are limited too', async () => {
    const f = target('http10');
    await assert.rejects(client.download(`http://127.0.0.1:${raw.port}/http10-large`, f, { maxBytes: MB }), SizeLimitError);
    assert.equal(fs.existsSync(f), false);
  });

  test('a body shorter than its Content-Length is treated as a failed (retryable) download', async () => {
    const f = target('short');
    await assert.rejects(client.download(`http://127.0.0.1:${raw.port}/lying-short`, f, { maxBytes: MB }), (e) => isRetryable(e));
    assert.equal(fs.existsSync(f), false);
  });

  test('a body longer than its Content-Length never exceeds what was declared', async () => {
    const f = target('long');
    const res = await client.download(`http://127.0.0.1:${raw.port}/lying-long`, f, { maxBytes: MB });
    assert.equal(res.bytes, 100);
    assert.equal(fs.statSync(f).size, 100);
  });

  test('the limit applies to decoded bytes (gzip bomb protection)', async () => {
    const f = target('bomb');
    await assert.rejects(client.download(server.url('/gzip-bomb'), f, { maxBytes: MB }), SizeLimitError);
    assert.equal(fs.existsSync(f), false);
    await assert.rejects(client.fetch(server.url('/gzip-bomb'), { maxBytes: MB }), SizeLimitError);
  });

  test('gzip and brotli bodies are decoded', async () => {
    assert.equal((await client.fetch(server.url('/gzip'))).body.toString(), 'hello compressed world');
    assert.equal((await client.fetch(server.url('/br'))).body.toString(), 'brotli body');
  });
});

describe('redirects, timeouts and errors', () => {
  test('redirects are validated hop by hop', async () => {
    await assert.rejects(
      client.fetch(server.url('/redirect-out'), { checkRedirect: (u) => (u.hostname === '127.0.0.1' ? null : 'outside scope') }),
      (e) => e instanceof RedirectScopeError && e.location === 'http://evil.test/x',
    );
  });

  test('redirect loops are bounded', async () => {
    await assert.rejects(client.fetch(server.url('/loop'), { maxRedirects: 3 }), TooManyRedirectsError);
  });

  test('timeouts and cancellation', async () => {
    await assert.rejects(client.fetch(server.url('/slow'), { timeoutMs: 300 }), TimeoutError);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(client.fetch(server.url('/slow'), { signal: ctl.signal, timeoutMs: 5000 }), AbortedError);
  });

  test('HTTP errors carry status and Retry-After', async () => {
    const f = target('503');
    await assert.rejects(client.download(server.url('/503'), f), (e) => e instanceof HttpStatusError && e.status === 503 && e.retryAfterMs === 2000 && isRetryable(e));
  });
});

describe('SSRF protection', () => {
  test('private and loopback targets are refused by default', async () => {
    const strict = new HttpClient({ userAgent: 'test' });
    await assert.rejects(strict.fetch(server.url('/small')), BlockedRequestError);
    await assert.rejects(strict.fetch('http://169.254.169.254/latest/meta-data/'), BlockedRequestError);
    await assert.rejects(strict.fetch('http://[::1]/'), BlockedRequestError);
    const mapped = new HttpClient({ userAgent: 'test', resolveOverride: (h) => (h === 'innocent.test' ? [{ address: '127.0.0.1', family: 4 }] : null) });
    await assert.rejects(mapped.fetch(`http://innocent.test:${server.port}/small`), BlockedRequestError, 'DNS answers are checked too');
    strict.close();
    mapped.close();
  });

  test('a redirect from an allowed host to a blocked address is refused at connection time', async () => {
    const dual = await startServer((req, res) => {
      if (req.url === '/hop') {
        res.writeHead(302, { location: `http://internal.test:${dual.port}/secret` });
        return res.end();
      }
      return res.end('secret');
    }, { listenHost: '::' });
    // public.test -> 127.0.0.1 (allowed by this policy), internal.test -> ::1 (blocked)
    const c = new HttpClient({
      userAgent: 'test',
      resolveOverride: (h) => ({ 'public.test': [{ address: '127.0.0.1', family: 4 }], 'internal.test': [{ address: '::1', family: 6 }] })[h] ?? null,
      isBlockedAddress: (a) => a === '::1',
    });
    await assert.rejects(c.fetch(`http://public.test:${dual.port}/hop`), BlockedRequestError);
    assert.equal(dual.hitCount(`public.test/hop`), 1);
    assert.equal(dual.hitCount(`internal.test/secret`), 0, 'blocked host was never contacted');
    c.close();
    await dual.close();
  });
});
