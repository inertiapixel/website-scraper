/**
 * In-process forward proxy that all browser traffic is routed through.
 *
 * Playwright's request interception does not see redirect hops, so a page
 * could otherwise redirect the browser to a loopback/private/metadata
 * address. Routing Chromium through this proxy means *every* connection
 * (plain HTTP requests, each redirect hop, HTTPS CONNECT tunnels and
 * WebSockets) is resolved with the same SSRF-checked DNS lookup used by the
 * HTTP client, and the connection goes to exactly the address that was
 * checked (no time-of-check/time-of-use gap).
 *
 * The proxy listens on 127.0.0.1 with a random port for the lifetime of a
 * worker only.
 */
import http from 'node:http';
import net from 'node:net';
import { hostnameForLookup, isBlockedAddress } from './ip.js';

const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);

function filterRawHeaders(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

export class GuardProxy {
  /**
   * @param {object} opts
   * @param {Function} opts.lookup dns.lookup-compatible function that rejects blocked addresses
   * @param {boolean} opts.allowPrivateNetworks
   * @param {(address: string) => boolean} [opts.isBlocked]
   * @param {object} [opts.logger]
   */
  constructor({ lookup, allowPrivateNetworks, isBlocked = isBlockedAddress, logger }) {
    this.lookup = lookup;
    this.isBlocked = isBlocked;
    this.allowPrivateNetworks = allowPrivateNetworks;
    this.logger = logger;
    this.sockets = new Set();
    this.blockedCount = 0;
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    this.server.on('connect', (req, socket, head) => this.#onConnect(req, socket, head));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server.on('clientError', (_err, socket) => socket.destroy());
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return `http://127.0.0.1:${this.port}`;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(() => resolve()));
  }

  #literalBlocked(host) {
    const h = hostnameForLookup(host);
    return net.isIP(h) && !this.allowPrivateNetworks && this.isBlocked(h);
  }

  #blocked(target, reason) {
    this.blockedCount++;
    this.logger?.debug(`Browser request to ${target} blocked: ${reason}`);
  }

  #onRequest(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    if (this.#literalBlocked(target.hostname)) {
      this.#blocked(target.host, 'private address');
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by website-scraper network policy');
      return;
    }
    const headers = filterRawHeaders(req.rawHeaders);
    const upstream = http.request({
      protocol: 'http:',
      hostname: hostnameForLookup(target.hostname),
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers,
      lookup: this.lookup,
      setHost: false,
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode, up.statusMessage, filterRawHeaders(up.rawHeaders));
      up.pipe(res);
      up.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (err.code === 'BLOCKED') this.#blocked(target.host, err.message);
      if (!res.headersSent) res.writeHead(err.code === 'BLOCKED' ? 403 : 502, { 'content-type': 'text/plain' });
      res.end();
    });
    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
  }

  #onConnect(req, clientSocket, head) {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    if (!m) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const [, host, port] = m;
    if (this.#literalBlocked(host)) {
      this.#blocked(req.url, 'private address');
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host, port: Number(port), lookup: this.lookup });
    upstream.setTimeout(120_000, () => upstream.destroy());
    upstream.once('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', (err) => {
      if (err.code === 'BLOCKED') this.#blocked(req.url, err.message);
      if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${err.code === 'BLOCKED' ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`);
    });
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
  }
}
