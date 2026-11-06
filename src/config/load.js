/**
 * Configuration loading.
 *
 *   1. `scraper.config.json` (package root) - the single source of defaults.
 *      It must contain every key; missing or unknown keys are errors.
 *   2. Optional overlay files (`--config <file>`), deep-merged in order.
 *      Overlays may be partial but unknown keys are still errors.
 *   3. Command-line overrides, deep-merged last.
 *
 * Arrays are replaced (not concatenated) when merged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from '../util/errors.js';
import { SCHEMA, validateNode, crossValidate } from './schema.js';
import { validateStartUrl } from '../url/normalize.js';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CONFIG_PATH = path.join(PACKAGE_ROOT, 'scraper.config.json');

function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`Cannot read ${label} "${file}": ${err.code === 'ENOENT' ? 'file not found' : err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${label} "${file}" is not valid JSON: ${err.message}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(target, source) {
  const out = structuredClone(target);
  for (const [k, v] of Object.entries(source)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

/** Turn `{ "crawler.maxDepth": 3 }` style paths into nested objects. */
export function setPath(obj, dottedPath, value) {
  const keys = dottedPath.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Load and validate the effective configuration.
 * @param {object} opts
 * @param {string} [opts.baseConfigPath]
 * @param {string[]} [opts.overlayPaths]
 * @param {object} [opts.overrides] nested partial config (from CLI flags)
 * @param {boolean} [opts.requireStartUrl]
 */
export function loadConfig({ baseConfigPath = DEFAULT_CONFIG_PATH, overlayPaths = [], overrides = {}, requireStartUrl = false } = {}) {
  const base = readJsonFile(baseConfigPath, 'Configuration file');
  const baseProblems = [];
  validateNode(SCHEMA, base, '', baseProblems, { requireAll: true });
  if (baseProblems.length) throw new ConfigError(baseProblems.map((p) => `${path.basename(baseConfigPath)}: ${p}`));

  let merged = base;
  for (const overlayPath of overlayPaths) {
    const resolved = path.resolve(overlayPath);
    const overlay = readJsonFile(resolved, 'Configuration overlay');
    const problems = [];
    validateNode(SCHEMA, overlay, '', problems);
    if (problems.length) throw new ConfigError(problems.map((p) => `${path.basename(resolved)}: ${p}`));
    merged = deepMerge(merged, overlay);
  }

  if (overrides && Object.keys(overrides).length) {
    const problems = [];
    validateNode(SCHEMA, overrides, '', problems);
    if (problems.length) throw new ConfigError(problems.map((p) => `command-line option: ${p}`));
    merged = deepMerge(merged, overrides);
  }

  return finalizeConfig(merged, { requireStartUrl });
}

/** Validate a fully merged configuration object (also used for job snapshots). */
export function finalizeConfig(config, { requireStartUrl = false } = {}) {
  const problems = [];
  validateNode(SCHEMA, config, '', problems, { requireAll: true });
  if (!problems.length) crossValidate(config, problems);

  if (!problems.length && config.website.startUrl) {
    try {
      const start = validateStartUrl(config.website.startUrl);
      const host = start.hostname;
      if (config.website.excludedHosts.includes(host)) {
        problems.push(`The starting host "${host}" is listed in website.excludedHosts`);
      }
      if (config.website.includeSubdomains && /^[\d.]+$|^\[/.test(host)) {
        problems.push('website.includeSubdomains cannot be used when the starting URL is an IP address');
      }
    } catch (err) {
      problems.push(err.message);
    }
  } else if (!problems.length && requireStartUrl) {
    problems.push('A starting URL is required (pass it on the command line or set website.startUrl)');
  }

  if (problems.length) throw new ConfigError(problems);
  return config;
}
