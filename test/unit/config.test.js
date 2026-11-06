import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../../src/config/load.js';
import { ConfigError } from '../../src/util/errors.js';
import { overridesFromFlags, SCRAPE_OPTIONS, parse } from '../../src/cli/args.js';
import { tempDir } from '../helpers/fixtures.js';

test('the shipped configuration is valid and has the documented defaults', () => {
  const c = loadConfig();
  assert.equal(c.website.includeSubdomains, false);
  assert.equal(c.website.crawlExternalPages, false);
  assert.equal(c.crawler.maxDepth, null);
  assert.equal(c.crawler.maxPages, null);
  assert.equal(c.crawler.respectRobotsTxt, true);
  assert.equal(c.download.maxFileSizeMb, 1);
  assert.deepEqual(c.download.excludedMimeTypes, ['video/*', 'audio/*']);
  for (const ext of ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.wma']) {
    assert.ok(c.download.excludedExtensions.includes(ext), ext);
  }
  assert.equal(c.network.allowPrivateNetworks, false);
});

test('misspelled keys are rejected with a suggestion', () => {
  assert.throws(() => loadConfig({ overrides: { crawler: { concurency: 2 } } }), (e) => e instanceof ConfigError && /Unknown configuration key "crawler.concurency". Did you mean "crawler.concurrency"/.test(e.message));
  assert.throws(() => loadConfig({ overrides: { downlaod: {} } }), /Did you mean "download"/);
});

test('invalid values produce clear errors', () => {
  const cases = [
    [{ crawler: { concurrency: 0 } }, /crawler.concurrency must be between 1 and 16/],
    [{ crawler: { maxDepth: -1 } }, /crawler.maxDepth must be between/],
    [{ crawler: { maxDepth: 'deep' } }, /crawler.maxDepth must be an integer or null/],
    [{ crawler: { renderer: 'phantom' } }, /crawler.renderer must be one of/],
    [{ download: { maxFileSizeMb: 0 } }, /download.maxFileSizeMb must be between/],
    [{ download: { excludedExtensions: ['mp4'] } }, /must be a lowercase extension/],
    [{ download: { excludedMimeTypes: ['video'] } }, /must be a lowercase MIME type/],
    [{ website: { allowedHosts: ['https://www.x.com'] } }, /must be a hostname/],
    [{ crawler: { excludePaths: ['re:('] } }, /is not a valid pattern/],
    [{ website: { startUrl: 'ftp://x.com' } }, /must start with http/],
  ];
  for (const [overrides, re] of cases) assert.throws(() => loadConfig({ overrides }), re, JSON.stringify(overrides));
});

test('contradictory settings are rejected', () => {
  assert.throws(() => loadConfig({ overrides: { website: { allowedHosts: ['a.com'], excludedHosts: ['a.com'] } } }), /both website.allowedHosts and website.excludedHosts/);
  assert.throws(() => loadConfig({ overrides: { website: { startUrl: 'https://a.com', excludedHosts: ['a.com'] } } }), /starting host "a.com" is listed/);
  assert.throws(() => loadConfig({ overrides: { website: { startUrl: 'http://10.0.0.1', includeSubdomains: true } } }), /IP address/);
  assert.throws(() => loadConfig({ overrides: { website: { downloadExternalAssets: false, externalAssetHosts: ['cdn.com'] } } }), /externalAssetHosts is set/);
  assert.throws(() => loadConfig({ overrides: { download: { includedCategories: [] } } }), /must not be empty/);
});

test('maxFileSizeMb null means unlimited', () => {
  assert.equal(loadConfig({ overrides: { download: { maxFileSizeMb: null } } }).download.maxFileSizeMb, null);
});

test('the base file must contain every key', () => {
  const dir = tempDir();
  const base = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  delete base.crawler.retries;
  const p = path.join(dir, 'base.json');
  fs.writeFileSync(p, JSON.stringify(base));
  assert.throws(() => loadConfig({ baseConfigPath: p }), /Missing required configuration key "crawler.retries"/);
  fs.writeFileSync(p, '{ not json');
  assert.throws(() => loadConfig({ baseConfigPath: p }), /is not valid JSON/);
});

test('overlay files merge (arrays replace) and are validated', () => {
  const dir = tempDir();
  const p = path.join(dir, 'overlay.json');
  fs.writeFileSync(p, JSON.stringify({ download: { excludedExtensions: ['.zip'] }, crawler: { maxPages: 10 } }));
  const c = loadConfig({ overlayPaths: [p] });
  assert.deepEqual(c.download.excludedExtensions, ['.zip']);
  assert.equal(c.crawler.maxPages, 10);
  assert.equal(c.crawler.concurrency, 2);
  fs.writeFileSync(p, JSON.stringify({ crawler: { maxPagez: 1 } }));
  assert.throws(() => loadConfig({ overlayPaths: [p] }), /overlay.json: Unknown configuration key "crawler.maxPagez"/);
});

test('CLI flags translate into validated overrides', () => {
  const { values, positionals } = parse(['https://x.com', '--max-depth', 'unlimited', '--max-pages', '5', '--allow-host', 'WWW.X.com',
    '--max-file-size', '2.5', '--no-external-assets', '--set', 'crawler.settle.delayMs=1500', '--include-subdomains'], SCRAPE_OPTIONS);
  const o = overridesFromFlags(values, positionals[0]);
  const c = loadConfig({ overrides: o, requireStartUrl: true });
  assert.equal(c.crawler.maxDepth, null);
  assert.equal(c.crawler.maxPages, 5);
  assert.deepEqual(c.website.allowedHosts, ['www.x.com']);
  assert.equal(c.download.maxFileSizeMb, 2.5);
  assert.equal(c.website.downloadExternalAssets, false);
  assert.equal(c.crawler.settle.delayMs, 1500);
  assert.equal(c.website.includeSubdomains, true);
  assert.throws(() => overridesFromFlags({ 'max-pages': 'many' }), /--max-pages must be a whole number/);
  assert.throws(() => overridesFromFlags({ 'allow-host': ['https://x.com/path'] }), /bare hostname/);
  assert.throws(() => parse(['--bogus'], SCRAPE_OPTIONS), /Unknown option '--bogus'/);
  assert.throws(() => loadConfig({ overrides: overridesFromFlags({ set: ['crawler.nope=1'] }) }), /Unknown configuration key "crawler.nope"/);
});
