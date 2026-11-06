import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, expandIPv6 } from '../../src/net/ip.js';

test('blocks loopback, private, link-local, metadata and reserved ranges', () => {
  for (const a of [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', 'not-an-ip',
  ]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
});

test('allows public addresses', () => {
  for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, a);
  }
});

test('expands IPv6 notation', () => {
  assert.deepEqual(expandIPv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
  assert.equal(expandIPv6('zzz'), null);
});
