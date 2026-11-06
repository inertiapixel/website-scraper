/**
 * Classification of IP addresses that must not be contacted by default
 * (SSRF protection): loopback, private, link-local (incl. cloud metadata
 * 169.254.169.254), CGNAT, multicast, reserved, documentation ranges and
 * IPv6 equivalents, including IPv4-mapped/NAT64/6to4 embeddings.
 */
import net from 'node:net';

const blockList = new net.BlockList();
const V4_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_RANGES = [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
  ['fec0::', 10], ['ff00::', 8],
];
for (const [addr, prefix] of V4_RANGES) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of V6_RANGES) blockList.addSubnet(addr, prefix, 'ipv6');

/** Expand an IPv6 address into 8 numeric hextets, or null if invalid. */
export function expandIPv6(address) {
  let addr = address.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (net.isIPv6(addr) === false) return null;
  // Convert a trailing dotted IPv4 part into two hextets.
  const v4Match = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    const o = v4Match[1].split('.').map(Number);
    addr = addr.slice(0, -v4Match[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, null];
  const headParts = head ? head.split(':').filter((p) => p !== '') : [];
  const tailParts = tail ? tail.split(':').filter((p) => p !== '') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === null && missing !== 0) return null;
  const parts = [...headParts, ...new Array(Math.max(0, missing)).fill('0'), ...tailParts];
  if (parts.length !== 8) return null;
  return parts.map((p) => parseInt(p, 16));
}

function embeddedIPv4(hextets) {
  const [a, b, c, d, e, f, g, h] = hextets;
  const toV4 = (x, y) => `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) {
    if (f === 0 && g === 0) return null; // :: or ::1 handled by the v6 list
    return toV4(g, h);
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return toV4(g, h);
  // 6to4 2002:AABB:CCDD::/48
  if (a === 0x2002) return toV4(b, c);
  return null;
}

/** True if the address belongs to a range that is blocked by default. */
export function isBlockedAddress(address) {
  const addr = String(address).replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(addr);
  if (family === 4) return blockList.check(addr, 'ipv4');
  if (family === 6) {
    if (blockList.check(addr, 'ipv6')) return true;
    const hextets = expandIPv6(addr);
    if (!hextets) return true;
    const v4 = embeddedIPv4(hextets);
    return v4 ? blockList.check(v4, 'ipv4') : false;
  }
  return true; // not an IP at all: refuse
}

/** Strip IPv6 brackets from a URL hostname. */
export function hostnameForLookup(hostname) {
  return String(hostname).replace(/^\[|\]$/g, '');
}
