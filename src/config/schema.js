/**
 * Declarative configuration schema. The schema only describes *types and
 * constraints*; default values live exclusively in `scraper.config.json`.
 */
import { compilePattern, editDistance } from '../util/glob.js';

export const ASSET_CATEGORIES = Object.freeze([
  'stylesheet', 'script', 'image', 'font', 'document', 'data', 'video', 'audio', 'other',
]);

export const BROWSER_RESOURCE_TYPES = Object.freeze([
  'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch',
  'eventsource', 'websocket', 'manifest', 'other',
]);

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// ---- type constructors ---------------------------------------------------

const bool = () => ({ type: 'boolean' });
const int = (min, max, opts = {}) => ({ type: 'integer', min, max, ...opts });
const num = (min, max, opts = {}) => ({ type: 'number', min, max, ...opts });
const str = (opts = {}) => ({ type: 'string', ...opts });
const arr = (item, opts = {}) => ({ type: 'array', item, ...opts });
const obj = (fields) => ({ type: 'object', fields });

const hostPatternItem = str({
  validate(v) {
    const lower = v.toLowerCase();
    if (lower !== v) return 'must be lowercase';
    if (!HOST_PATTERN.test(v)) return 'must be a hostname such as "example.com" or "*.example.com"';
    return null;
  },
});

const pathPatternItem = str({
  validate(v) {
    if (!v.startsWith('/') && !v.startsWith('re:') && !v.startsWith('*')) {
      return 'must start with "/", "*" or "re:"';
    }
    try {
      compilePattern(v);
    } catch (err) {
      return `is not a valid pattern (${err.message})`;
    }
    return null;
  },
});

const urlPatternItem = str({
  validate(v) {
    try {
      compilePattern(v);
    } catch (err) {
      return `is not a valid pattern (${err.message})`;
    }
    return null;
  },
});

const extensionItem = str({
  validate(v) {
    if (!/^\.[a-z0-9][a-z0-9._-]*$/.test(v)) return 'must be a lowercase extension starting with "." (e.g. ".mp4")';
    return null;
  },
});

const mimePatternItem = str({
  validate(v) {
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$/.test(v)) {
      return 'must be a lowercase MIME type such as "video/mp4" or "video/*"';
    }
    return null;
  },
});

const queryParamItem = str({
  validate(v) {
    if (!v.length) return 'must not be empty';
    return null;
  },
});

export const SCHEMA = obj({
  website: obj({
    startUrl: str({ nullable: true }),
    allowedHosts: arr(hostPatternItem),
    excludedHosts: arr(hostPatternItem),
    includeSubdomains: bool(),
    crawlExternalPages: bool(),
    downloadExternalAssets: bool(),
    externalAssetHosts: arr(hostPatternItem),
  }),
  crawler: obj({
    renderer: str({ enum: ['browser', 'http'] }),
    maxDepth: int(0, 1_000_000, { nullable: true }),
    maxPages: int(1, 10_000_000, { nullable: true }),
    concurrency: int(1, 16),
    requestDelayMs: int(0, 600_000),
    navigationTimeoutMs: int(1000, 600_000),
    maxPageSizeMb: num(0.01, 1024),
    userAgent: str({ nonEmpty: true }),
    respectRobotsTxt: bool(),
    maxRobotsCrawlDelayMs: int(0, 600_000),
    retries: int(0, 10),
    retryBackoffMs: int(0, 600_000),
    maxRedirects: int(0, 30),
    includePaths: arr(pathPatternItem),
    excludePaths: arr(pathPatternItem),
    ignoreTrailingSlash: bool(),
    settle: obj({
      waitUntil: str({ enum: ['commit', 'domcontentloaded', 'load'] }),
      networkQuietMs: int(0, 60_000),
      networkQuietTimeoutMs: int(0, 600_000),
      delayMs: int(0, 600_000),
      waitForSelector: str({ nullable: true, nonEmpty: true }),
    }),
    lazyLoad: obj({
      enabled: bool(),
      maxScrolls: int(0, 1000),
      scrollDelayMs: int(0, 60_000),
      promoteDataAttributes: bool(),
    }),
    sitemap: obj({
      enabled: bool(),
      maxUrls: int(0, 10_000_000),
      maxSitemaps: int(1, 10_000),
    }),
    queryParams: obj({
      mode: str({ enum: ['keep', 'allowlist', 'drop'] }),
      allow: arr(queryParamItem),
      strip: arr(queryParamItem),
      sort: bool(),
    }),
    trapProtection: obj({
      maxUrlLength: int(64, 100_000),
      maxPathSegments: int(1, 1000),
      maxRepeatedSegments: int(1, 1000),
      maxQueryVariantsPerPath: int(1, 10_000_000, { nullable: true }),
      maxUrlsPerPattern: int(1, 10_000_000, { nullable: true }),
      maxDiscoveredUrls: int(1, 100_000_000),
    }),
    blockBrowserResourceTypes: arr(str({ enum: BROWSER_RESOURCE_TYPES })),
  }),
  download: obj({
    enabled: bool(),
    maxFileSizeMb: num(0.001, 1_000_000, { nullable: true }),
    concurrency: int(1, 32),
    requestDelayMs: int(0, 600_000),
    timeoutMs: int(1000, 3_600_000),
    retries: int(0, 10),
    retryBackoffMs: int(0, 600_000),
    existingFiles: str({ enum: ['skip', 'overwrite'] }),
    maxCssImportDepth: int(0, 50),
    includedCategories: arr(str({ enum: ASSET_CATEGORIES })),
    excludedExtensions: arr(extensionItem),
    excludedMimeTypes: arr(mimePatternItem),
    excludedUrlPatterns: arr(urlPatternItem),
  }),
  output: obj({
    baseDir: str({ nonEmpty: true }),
    preserveStructure: bool(),
    rewriteUrls: bool(),
    saveRenderedHtml: bool(),
    removeScripts: bool(),
    generateReport: bool(),
    keepStaging: bool(),
  }),
  network: obj({
    allowPrivateNetworks: bool(),
  }),
  logging: obj({
    level: str({ enum: ['debug', 'info', 'warn', 'error'] }),
  }),
});

// ---- validation ------------------------------------------------------------

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 57)}...` : value);
  return typeof value === 'object' ? 'an object' : String(value);
}

function suggest(key, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const d = editDistance(key, c);
    if (d < bestScore) {
      bestScore = d;
      best = c;
    }
  }
  return best && bestScore <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

/**
 * Validate `value` against `schema`. Problems are appended to `problems`.
 * With `requireAll`, every schema key must be present (used for the base
 * configuration file, which is the single source of defaults).
 */
export function validateNode(schema, value, path, problems, { requireAll = false } = {}) {
  const where = path || '(root)';
  if (value === null && schema.nullable) return;

  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${where} must be an object (got ${describe(value)})`);
        return;
      }
      const known = Object.keys(schema.fields);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.fields, key)) {
          const hint = suggest(key, known);
          const full = path ? `${path}.${key}` : key;
          problems.push(`Unknown configuration key "${full}"${hint ? `. Did you mean "${path ? `${path}.` : ''}${hint}"?` : ''}`);
        }
      }
      for (const [key, child] of Object.entries(schema.fields)) {
        const full = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(value, key)) {
          if (requireAll) problems.push(`Missing required configuration key "${full}"`);
          continue;
        }
        validateNode(child, value[key], full, problems, { requireAll });
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${where} must be true or false (got ${describe(value)})`);
      return;
    case 'integer':
    case 'number': {
      const isNum = typeof value === 'number' && Number.isFinite(value);
      if (!isNum || (schema.type === 'integer' && !Number.isInteger(value))) {
        problems.push(`${where} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}${schema.nullable ? ' or null' : ''} (got ${describe(value)})`);
        return;
      }
      if ((schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max)) {
        problems.push(`${where} must be between ${schema.min} and ${schema.max} (got ${value})`);
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        problems.push(`${where} must be a string${schema.nullable ? ' or null' : ''} (got ${describe(value)})`);
        return;
      }
      if (schema.nonEmpty && !value.trim()) problems.push(`${where} must not be empty`);
      if (schema.enum && !schema.enum.includes(value)) {
        problems.push(`${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')} (got ${describe(value)})`);
      }
      if (schema.validate) {
        const msg = schema.validate(value);
        if (msg) problems.push(`${where} ${msg} (got ${describe(value)})`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        problems.push(`${where} must be an array (got ${describe(value)})`);
        return;
      }
      value.forEach((item, i) => validateNode(schema.item, item, `${where}[${i}]`, problems, { requireAll }));
      return;
    }
    default:
      throw new Error(`Unknown schema type ${schema.type}`);
  }
}

/** Cross-field checks that only make sense on the fully merged configuration. */
export function crossValidate(config, problems) {
  const w = config.website;
  for (const h of w.allowedHosts) {
    if (w.excludedHosts.includes(h)) problems.push(`Host "${h}" is listed in both website.allowedHosts and website.excludedHosts`);
  }
  for (const h of w.externalAssetHosts) {
    if (w.excludedHosts.includes(h)) problems.push(`Host "${h}" is listed in both website.externalAssetHosts and website.excludedHosts`);
  }
  if (w.externalAssetHosts.length && !w.downloadExternalAssets) {
    problems.push('website.externalAssetHosts is set but website.downloadExternalAssets is false; enable downloadExternalAssets or clear the list');
  }
  const d = config.download;
  if (d.enabled && d.includedCategories.length === 0) {
    problems.push('download.includedCategories must not be empty while download.enabled is true');
  }
  const q = config.crawler.queryParams;
  if (q.mode !== 'allowlist' && q.allow.length) {
    problems.push('crawler.queryParams.allow is only used when crawler.queryParams.mode is "allowlist"');
  }
  if (config.crawler.renderer === 'http' && config.crawler.settle.waitForSelector) {
    problems.push('crawler.settle.waitForSelector requires crawler.renderer "browser"');
  }
  if (!config.output.rewriteUrls && config.output.removeScripts) {
    // Script removal happens in the rewrite pass.
    problems.push('output.removeScripts requires output.rewriteUrls to be true');
  }
}
