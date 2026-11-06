/**
 * Local fixture servers for tests. Nothing in the test suite touches the
 * public internet: fake hostnames (xyz.test, www.xyz.test, cdn.test, ...)
 * are mapped to 127.0.0.1 through the crawler's resolveOverride hook, and
 * the server routes requests by Host header.
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function startServer(handler, { listenHost = '127.0.0.1' } = {}) {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const key = `${host}${req.url}`;
    hits.set(key, (hits.get(key) || 0) + 1);
    Promise.resolve(handler(req, res, { host, path: req.url })).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, listenHost, r));
  const port = server.address().port;
  return {
    port,
    hits,
    hitCount(hostAndPath) {
      return hits.get(hostAndPath) || 0;
    },
    url(p = '/', host = '127.0.0.1') {
      return `http://${host}:${port}${p}`;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Raw TCP server for malformed HTTP responses (wrong Content-Length, etc.). */
export async function startRawServer(respond) {
  const server = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n')) {
        const firstLine = buf.split('\r\n')[0];
        respond(socket, firstLine.split(' ')[1]);
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A static site keyed by "host/path" (or "/path" for any host). */
export function siteHandler(routes) {
  return (req, res, { host, path: p }) => {
    const route = routes[`${host}${p}`] ?? routes[p];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
      return;
    }
    if (typeof route === 'function') return route(req, res);
    const headers = { 'content-type': route.type || 'text/html; charset=utf-8', ...(route.headers || {}) };
    if (route.delay) {
      return new Promise((resolve) => setTimeout(() => {
        res.writeHead(route.status || 200, headers);
        res.end(route.body ?? '');
        resolve();
      }, route.delay));
    }
    res.writeHead(route.status || 200, headers);
    res.end(route.body ?? '');
    return undefined;
  };
}

export function html(body, head = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body>${body}</body></html>`;
}

export function bytes(n, fill = 0x41) {
  return Buffer.alloc(n, fill);
}

/** Map fake hostnames to loopback for the crawler and browser guard proxy. */
export function loopbackResolver(hosts) {
  const set = new Set(hosts);
  return (hostname) => (set.has(hostname) ? [{ address: '127.0.0.1', family: 4 }] : null);
}

const createdDirs = [];
process.on('exit', () => {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Temporary directory, removed automatically when the test process exits. */
export function tempDir(prefix = 'ws-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

/** Minimal valid binary headers used by sniffing tests. */
export const SIGNATURES = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]),
  mp3: Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 0])]),
};
