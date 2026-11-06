/**
 * Domain scope rules.
 *
 * Pages: by default only the exact hostname of the starting URL is crawled.
 * `www.example.com` is a different host from `example.com` and is NOT
 * crawled unless it is listed in `website.allowedHosts` (or
 * `includeSubdomains` is enabled). Hostnames are compared exactly after URL
 * parsing; substring matching is never used, so `notexample.com` and
 * `example.com.evil.net` are always rejected.
 *
 * Assets: in-scope hosts are always allowed. Other hosts are allowed only
 * when `website.downloadExternalAssets` is true (optionally restricted by
 * `website.externalAssetHosts`). Allowing an asset host never makes its
 * pages crawlable.
 */
import net from 'node:net';
import { hostMatchesAny } from '../util/glob.js';
import { normalizeHostname } from './normalize.js';

/** True when `hostname` equals `root` or is a true subdomain of it (label boundary). */
export function isSameOrSubdomain(hostname, root) {
  const h = normalizeHostname(hostname);
  const r = normalizeHostname(root);
  if (!h || !r) return false;
  if (h === r) return true;
  if (net.isIP(r) || net.isIP(h.replace(/^\[|\]$/g, ''))) return false;
  return h.length > r.length + 1 && h.endsWith(`.${r}`);
}

export function createScope(website, startUrl) {
  const primaryHost = normalizeHostname(startUrl.hostname);
  const allowed = website.allowedHosts.map(normalizeHostname);
  const excluded = website.excludedHosts.map(normalizeHostname);
  const assetHosts = website.externalAssetHosts.map(normalizeHostname);

  function isExcluded(host) {
    return hostMatchesAny(host, excluded);
  }

  /** True when pages on this host belong to the site being captured. */
  function isInternalHost(hostname) {
    const host = normalizeHostname(hostname);
    if (!host || isExcluded(host)) return false;
    if (host === primaryHost) return true;
    if (website.includeSubdomains && isSameOrSubdomain(host, primaryHost)) return true;
    return hostMatchesAny(host, allowed);
  }

  /**
   * Classify a page URL host:
   *   internal  - crawl and follow links
   *   external  - only when crawlExternalPages is enabled: capture, never follow links
   *   excluded  - never crawl
   */
  function classifyPageHost(hostname) {
    const host = normalizeHostname(hostname);
    if (isExcluded(host)) return { scope: 'excluded', reason: `host "${host}" is excluded by website.excludedHosts` };
    if (isInternalHost(host)) return { scope: 'internal' };
    if (website.crawlExternalPages) return { scope: 'external' };
    const isSub = isSameOrSubdomain(host, primaryHost);
    return {
      scope: 'excluded',
      reason: isSub
        ? `subdomain "${host}" is outside the allowed hosts (add it to website.allowedHosts or enable includeSubdomains)`
        : `external host "${host}" is outside the allowed hosts`,
    };
  }

  /** Whether an asset on this host may be downloaded. */
  function checkAssetHost(hostname) {
    const host = normalizeHostname(hostname);
    if (isExcluded(host)) return { allowed: false, reason: `host "${host}" is excluded by website.excludedHosts` };
    if (isInternalHost(host)) return { allowed: true, internal: true };
    if (!website.downloadExternalAssets) {
      return { allowed: false, reason: `external asset host "${host}" (website.downloadExternalAssets is false)` };
    }
    if (assetHosts.length && !hostMatchesAny(host, assetHosts)) {
      return { allowed: false, reason: `external asset host "${host}" is not in website.externalAssetHosts` };
    }
    return { allowed: true, internal: false };
  }

  return { primaryHost, isInternalHost, classifyPageHost, checkAssetHost };
}
