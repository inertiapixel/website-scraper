/**
 * Download eligibility decisions, applied in three stages:
 *   1. before the request: host scope, URL patterns, extension, context category
 *   2. after response headers: MIME exclusions and category inclusion
 *   3. on the first body bytes: magic-byte sniffing (catches audio/video with
 *      no extension, a misleading extension or a generic/misleading MIME type)
 */
import { SkipError } from '../util/errors.js';
import { compilePatternList } from '../util/glob.js';
import {
  categoryFromExtension, categoryFromMime, extensionOf, isGenericMime, mimeFromExtension, mimeMatches, sniff,
} from '../content/filetype.js';

const CONTENT_HINTS = new Set(['image', 'font', 'script', 'stylesheet']);

export function createAssetFilter(config, scope) {
  const d = config.download;
  const excludedExt = new Set(d.excludedExtensions);
  const included = new Set(d.includedCategories);
  const urlExcluded = d.excludedUrlPatterns.length ? compilePatternList(d.excludedUrlPatterns) : null;
  const maxBytes = d.maxFileSizeMb == null ? null : Math.floor(d.maxFileSizeMb * 1024 * 1024);

  /** @returns {null | { code: string, message: string }} */
  function beforeRequest(url, hint, cssDepth = 0) {
    const host = scope.checkAssetHost(url.hostname);
    if (!host.allowed) return { code: 'out-of-scope', message: host.reason };
    if (urlExcluded && urlExcluded(url.href)) return { code: 'excluded-url-pattern', message: 'matches download.excludedUrlPatterns' };
    const ext = extensionOf(url.pathname);
    if (ext && excludedExt.has(ext)) return { code: 'excluded-extension', message: `extension ${ext} is excluded` };
    const category = categoryFromExtension(ext) || hint;
    if (category && !included.has(category)) {
      return { code: 'excluded-category', message: `category "${category}" is not in download.includedCategories` };
    }
    if (cssDepth > d.maxCssImportDepth) return { code: 'css-depth', message: `CSS reference depth exceeds ${d.maxCssImportDepth}` };
    return null;
  }

  /** Redirect hops for assets: scope + extension rules apply to every hop. */
  function checkRedirect(next) {
    const host = scope.checkAssetHost(next.hostname);
    if (!host.allowed) return host.reason;
    const ext = extensionOf(next.pathname);
    if (ext && excludedExt.has(ext)) return `redirect target extension ${ext} is excluded`;
    return null;
  }

  /** Decide from headers. Throws SkipError; returns the provisional category. */
  function afterHeaders(info, hint, url) {
    const mime = info.mime;
    if (mime && mimeMatches(mime, d.excludedMimeTypes)) {
      throw new SkipError('excluded-mime', `MIME type ${mime} is excluded`);
    }
    const mimeCategory = categoryFromMime(mime);
    if (mimeCategory === 'html' && CONTENT_HINTS.has(hint)) {
      throw new SkipError('unexpected-html', `expected ${hint} but the server returned HTML`);
    }
    const category = (mimeCategory && mimeCategory !== 'html' ? mimeCategory : null)
      || categoryFromExtension(extensionOf(new URL(info.finalUrl || url).pathname))
      || hint || 'other';
    if (!included.has(category)) {
      throw new SkipError('excluded-category', `category "${category}" (${mime || 'no MIME type'}) is not in download.includedCategories`);
    }
    return category;
  }

  /** Inspect the first bytes. Throws SkipError for excluded content; returns sniff result or null. */
  function afterFirstBytes(buf, info) {
    const generic = !info.mime || isGenericMime(info.mime);
    const sniffed = sniff(buf, { strict: generic });
    if (!sniffed) return null;
    if (mimeMatches(sniffed.mime, d.excludedMimeTypes) || !included.has(sniffed.category)) {
      throw new SkipError('excluded-mime', `content is ${sniffed.mime} (detected from file signature)`);
    }
    return sniffed;
  }

  /** Effective MIME type for naming: declared, else sniffed, else from extension. */
  function effectiveMime(info, sniffed, url) {
    if (info.mime && !isGenericMime(info.mime)) return info.mime;
    if (sniffed) return sniffed.mime;
    return mimeFromExtension(extensionOf(new URL(url).pathname));
  }

  return { maxBytes, beforeRequest, checkRedirect, afterHeaders, afterFirstBytes, effectiveMime };
}
