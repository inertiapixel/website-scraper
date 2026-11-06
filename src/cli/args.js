/**
 * Command-line option definitions and translation of flags into
 * configuration overrides. Every override is validated by the same schema
 * as the configuration file.
 */
import { parseArgs } from 'node:util';
import { UsageError } from '../util/errors.js';
import { setPath } from '../config/load.js';
import { normalizeHostname } from '../url/normalize.js';

export const SCRAPE_OPTIONS = {
  background: { type: 'boolean', short: 'b' },
  follow: { type: 'boolean', short: 'f' },
  'no-notify': { type: 'boolean' },
  foreground: { type: 'boolean' },
  config: { type: 'string', short: 'c', multiple: true },
  'max-depth': { type: 'string' },
  'max-pages': { type: 'string' },
  concurrency: { type: 'string' },
  delay: { type: 'string' },
  timeout: { type: 'string' },
  renderer: { type: 'string' },
  'user-agent': { type: 'string' },
  'include-subdomains': { type: 'boolean' },
  'allow-host': { type: 'string', multiple: true },
  'exclude-host': { type: 'string', multiple: true },
  'include-path': { type: 'string', multiple: true },
  'exclude-path': { type: 'string', multiple: true },
  'crawl-external-pages': { type: 'boolean' },
  'external-assets': { type: 'boolean' },
  'no-external-assets': { type: 'boolean' },
  'no-assets': { type: 'boolean' },
  'max-file-size': { type: 'string' },
  'no-sitemap': { type: 'boolean' },
  'ignore-robots': { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  'remove-scripts': { type: 'boolean' },
  'no-rewrite': { type: 'boolean' },
  'allow-private-network': { type: 'boolean' },
  set: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export function parse(argv, options, { positionals = true } = {}) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: positionals, strict: true });
  } catch (err) {
    throw new UsageError(err.message.replace(/^TypeError \[[A-Z_]+\]: /, ''));
  }
}

function intOption(name, raw, { min = 0, unlimited = false } = {}) {
  const v = String(raw).trim().toLowerCase();
  if (unlimited && ['unlimited', 'none', 'null', 'infinite', 'inf'].includes(v)) return null;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number${unlimited ? ' or "unlimited"' : ''} (got "${raw}")`);
  const n = Number(v);
  if (n < min) throw new UsageError(`--${name} must be at least ${min}`);
  return n;
}

function hostOption(name, raw) {
  const v = String(raw).trim().toLowerCase();
  const wildcard = v.startsWith('*.');
  const bare = wildcard ? v.slice(2) : v;
  let host;
  try {
    host = new URL(`http://${bare}`).hostname;
  } catch {
    throw new UsageError(`--${name} expects a hostname such as "www.example.com" (got "${raw}")`);
  }
  if (host !== bare.replace(/\.$/, '') || bare.includes('/')) {
    throw new UsageError(`--${name} expects a bare hostname without scheme or path (got "${raw}")`);
  }
  return `${wildcard ? '*.' : ''}${normalizeHostname(host)}`;
}

function parseSetValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Translate parsed scrape flags into a nested configuration override object. */
export function overridesFromFlags(values, positionalUrl) {
  const o = {};
  if (positionalUrl) setPath(o, 'website.startUrl', positionalUrl);
  if (values['max-depth'] !== undefined) setPath(o, 'crawler.maxDepth', intOption('max-depth', values['max-depth'], { unlimited: true }));
  if (values['max-pages'] !== undefined) setPath(o, 'crawler.maxPages', intOption('max-pages', values['max-pages'], { min: 1, unlimited: true }));
  if (values.concurrency !== undefined) setPath(o, 'crawler.concurrency', intOption('concurrency', values.concurrency, { min: 1 }));
  if (values.delay !== undefined) setPath(o, 'crawler.requestDelayMs', intOption('delay', values.delay));
  if (values.timeout !== undefined) setPath(o, 'crawler.navigationTimeoutMs', intOption('timeout', values.timeout, { min: 1000 }));
  if (values.renderer !== undefined) setPath(o, 'crawler.renderer', values.renderer);
  if (values['user-agent'] !== undefined) setPath(o, 'crawler.userAgent', values['user-agent']);
  if (values['include-subdomains']) setPath(o, 'website.includeSubdomains', true);
  if (values['allow-host']) setPath(o, 'website.allowedHosts', values['allow-host'].map((h) => hostOption('allow-host', h)));
  if (values['exclude-host']) setPath(o, 'website.excludedHosts', values['exclude-host'].map((h) => hostOption('exclude-host', h)));
  if (values['include-path']) setPath(o, 'crawler.includePaths', values['include-path']);
  if (values['exclude-path']) setPath(o, 'crawler.excludePaths', values['exclude-path']);
  if (values['crawl-external-pages']) setPath(o, 'website.crawlExternalPages', true);
  if (values['external-assets'] && values['no-external-assets']) throw new UsageError('Use either --external-assets or --no-external-assets, not both');
  if (values['external-assets']) setPath(o, 'website.downloadExternalAssets', true);
  if (values['no-external-assets']) setPath(o, 'website.downloadExternalAssets', false);
  if (values['no-assets']) setPath(o, 'download.enabled', false);
  if (values['max-file-size'] !== undefined) {
    const v = String(values['max-file-size']).trim().toLowerCase();
    if (['unlimited', 'none', 'null'].includes(v)) setPath(o, 'download.maxFileSizeMb', null);
    else {
      const n = Number(v.replace(/mb$/, ''));
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--max-file-size must be a size in MB (e.g. 1 or 2.5) or "unlimited" (got "${values['max-file-size']}")`);
      setPath(o, 'download.maxFileSizeMb', n);
    }
  }
  if (values['no-sitemap']) setPath(o, 'crawler.sitemap.enabled', false);
  if (values['ignore-robots']) setPath(o, 'crawler.respectRobotsTxt', false);
  if (values.output !== undefined) setPath(o, 'output.baseDir', values.output);
  if (values['remove-scripts']) setPath(o, 'output.removeScripts', true);
  if (values['no-rewrite']) setPath(o, 'output.rewriteUrls', false);
  if (values['allow-private-network']) setPath(o, 'network.allowPrivateNetworks', true);
  for (const entry of values.set ?? []) {
    const idx = entry.indexOf('=');
    if (idx <= 0) throw new UsageError(`--set expects key.path=value (got "${entry}")`);
    setPath(o, entry.slice(0, idx).trim(), parseSetValue(entry.slice(idx + 1)));
  }
  return o;
}
