/**
 * HTML reference discovery and offline rewriting.
 *
 * One walker drives both extraction and rewriting, so every reference that
 * is discovered is also a reference that can be rewritten (and vice versa).
 */
import path from 'node:path/posix';
import * as cheerio from 'cheerio';
import { findCssReferences, rewriteCss, cssReferenceHint } from './css.js';
import { parseSrcset, serializeSrcset } from './srcset.js';
import { isIgnoredReference } from '../url/normalize.js';

// Parse <noscript> content as markup so lazy-load fallback images are seen.
const LOAD_OPTIONS = { scriptingEnabled: false };

const LAZY_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];
const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
const LAZY_BG_ATTRS = ['data-bg', 'data-background', 'data-background-image', 'data-poster'];
const ICON_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon', 'fluid-icon']);
const PAGE_META_RELS = new Set(['canonical', 'alternate', 'next', 'prev', 'author', 'help', 'license', 'search']);
const JSON_SCRIPT_TYPES = new Set(['application/ld+json', 'application/json', 'importmap', 'speculationrules']);

export function loadHtml(html) {
  return cheerio.load(html, LOAD_OPTIONS);
}

/** Asset category for a <link> element, or null when it is not a downloadable asset. */
export function linkElementHint(attribs) {
  const rels = String(attribs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (rels.includes('stylesheet')) return 'stylesheet';
  if (rels.some((r) => ICON_RELS.has(r))) return 'image';
  if (rels.includes('manifest')) return 'data';
  if (rels.includes('modulepreload')) return 'script';
  if (rels.includes('preload') || rels.includes('prefetch')) {
    const as = String(attribs.as || '').toLowerCase();
    return { style: 'stylesheet', script: 'script', font: 'font', image: 'image', fetch: 'data', track: 'data', video: 'video', audio: 'audio' }[as] ?? null;
  }
  return null;
}

function isPageMetaLink(attribs) {
  return String(attribs.rel || '').toLowerCase().split(/\s+/).some((r) => PAGE_META_RELS.has(r));
}

function parseRefresh(content) {
  const m = /^\s*\d*\.?\d*\s*[;,]?\s*(?:url\s*=\s*)?(['"]?)(.+?)\1\s*$/i.exec(String(content || ''));
  return m && m[2] && !/^\d+$/.test(m[2]) ? m[2] : null;
}

function sourceHint(el) {
  const parent = el.parent?.name?.toLowerCase();
  if (parent === 'video') return 'video';
  if (parent === 'audio') return 'audio';
  return 'image';
}

/**
 * Walk every URL-bearing attribute and inline stylesheet.
 * Visitor callbacks receive accessor objects with `get()` and `set(value)`.
 */
function walk($, visitor) {
  $('*').each((_i, el) => {
    const tag = el.name.toLowerCase();
    const a = el.attribs || {};
    const attr = (name, kind, hint) => {
      if (a[name] === undefined) return;
      visitor.url({ el, tag, name, kind, hint, get: () => el.attribs[name], set: (v) => { el.attribs[name] = v; } });
    };
    const srcset = (name, hint) => {
      if (a[name] === undefined) return;
      visitor.srcset({ el, tag, name, hint, get: () => el.attribs[name], set: (v) => { el.attribs[name] = v; } });
    };

    switch (tag) {
      case 'a':
      case 'area':
        attr('href', 'page');
        break;
      case 'iframe':
      case 'frame':
        attr('src', 'page');
        break;
      case 'img':
        attr('src', 'asset', 'image');
        srcset('srcset', 'image');
        break;
      case 'source':
        attr('src', 'asset', sourceHint(el));
        srcset('srcset', 'image');
        break;
      case 'video':
        attr('src', 'asset', 'video');
        attr('poster', 'asset', 'image');
        break;
      case 'audio':
        attr('src', 'asset', 'audio');
        break;
      case 'track':
        attr('src', 'asset', 'data');
        break;
      case 'script':
        attr('src', 'asset', 'script');
        break;
      case 'embed':
        attr('src', 'asset', 'other');
        break;
      case 'object':
        attr('data', 'asset', 'other');
        break;
      case 'input':
        if (String(a.type || '').toLowerCase() === 'image') attr('src', 'asset', 'image');
        break;
      case 'body':
      case 'table':
      case 'td':
      case 'th':
        attr('background', 'asset', 'image');
        break;
      case 'link': {
        const hint = linkElementHint(a);
        if (hint) attr('href', 'asset', hint);
        else if (isPageMetaLink(a)) attr('href', 'absolute');
        break;
      }
      case 'image':
      case 'use':
      case 'feimage':
        attr('href', 'asset', 'image');
        attr('xlink:href', 'asset', 'image');
        break;
      case 'meta':
        if (String(a['http-equiv'] || '').toLowerCase() === 'refresh' && a.content) {
          const target = parseRefresh(a.content);
          if (target) {
            visitor.url({
              el, tag, name: 'content', kind: 'page',
              get: () => parseRefresh(el.attribs.content),
              set: (v) => { el.attribs.content = el.attribs.content.replace(target, v); },
            });
          }
        }
        break;
      case 'style':
        visitor.css({ el, inline: false, get: () => $(el).text(), set: (v) => $(el).text(v) });
        break;
      default:
        break;
    }

    for (const name of LAZY_SRC_ATTRS) attr(name, 'asset', 'image');
    for (const name of LAZY_SRCSET_ATTRS) srcset(name, 'image');
    for (const name of LAZY_BG_ATTRS) attr(name, 'asset', 'image');
    if (a.style !== undefined && a.style.includes('(')) {
      visitor.css({ el, inline: true, get: () => el.attribs.style, set: (v) => { el.attribs.style = v; } });
    }
  });
}

/** Effective base URL: first <base href>, resolved against the page URL. */
export function documentBaseUrl($, pageUrl) {
  const href = $('base[href]').first().attr('href');
  if (!href) return pageUrl;
  try {
    return new URL(href.trim(), pageUrl).href;
  } catch {
    return pageUrl;
  }
}

function resolveRef(raw, baseUrl) {
  if (isIgnoredReference(raw)) return null;
  try {
    const u = new URL(String(raw).trim(), baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * Extract page links and asset references from an HTML document.
 * @returns {{ links: string[], assets: Array<{url:string, hint:string}>, baseUrl: string }}
 */
export function extractReferences(html, pageUrl) {
  const $ = typeof html === 'string' ? loadHtml(html) : html;
  const baseUrl = documentBaseUrl($, pageUrl);
  const links = [];
  const assets = [];
  const addCss = (cssText, base) => {
    for (const ref of findCssReferences(cssText)) {
      const u = resolveRef(ref.value, base);
      if (u) assets.push({ url: u.href, hint: cssReferenceHint(ref, u.href) });
    }
  };
  walk($, {
    url(ref) {
      const u = resolveRef(ref.get(), baseUrl);
      if (!u) return;
      if (ref.kind === 'page') links.push(u.href);
      else if (ref.kind === 'asset') assets.push({ url: u.href, hint: ref.hint });
    },
    srcset(ref) {
      for (const c of parseSrcset(ref.get())) {
        const u = resolveRef(c.url, baseUrl);
        if (u) assets.push({ url: u.href, hint: ref.hint });
      }
    },
    css(ref) {
      addCss(ref.get(), baseUrl);
    },
  });
  return { links, assets, baseUrl };
}

/** Relative URL from one local file to another (both relative to the job root). */
export function relativeHref(fromFile, toFile) {
  let rel = path.relative(path.dirname(fromFile), toFile);
  if (!rel) rel = path.basename(toFile);
  return rel.split('/').map((seg) => (seg === '..' || seg === '.' ? seg : encodeURIComponent(seg))).join('/');
}

/**
 * Rewrite a saved page for offline browsing.
 *
 * @param {string} html raw saved HTML
 * @param {object} opts
 * @param {string} opts.pageUrl final URL of the page (resolution base)
 * @param {string} opts.localPath page path relative to the job root
 * @param {(url: URL) => string|null} opts.resolvePage local path of a captured page
 * @param {(url: URL, hint: string) => string|null} opts.resolveAsset local path of a downloaded asset
 * @param {boolean} [opts.removeScripts]
 * @param {boolean} [opts.promoteLazy]
 */
export function rewriteHtml(html, { pageUrl, localPath, resolvePage, resolveAsset, removeScripts = false, promoteLazy = true }) {
  const $ = loadHtml(html);
  const baseUrl = documentBaseUrl($, pageUrl);
  const stats = { localized: 0, absolutized: 0 };

  const mapUrl = (raw, kind, hint) => {
    const u = resolveRef(raw, baseUrl);
    if (!u) return null;
    const hash = u.hash;
    if (kind === 'page' || kind === 'asset') {
      const local = kind === 'page' ? resolvePage(u) : resolveAsset(u, hint);
      if (local) {
        stats.localized++;
        return relativeHref(localPath, local) + hash;
      }
    }
    stats.absolutized++;
    return u.href;
  };

  const mapCss = (cssText) =>
    rewriteCss(cssText, (ref) => {
      const u = resolveRef(ref.value, baseUrl);
      if (!u) return null;
      return mapUrl(ref.value, 'asset', cssReferenceHint(ref, u.href));
    });

  walk($, {
    url(ref) {
      const raw = ref.get();
      const next = mapUrl(raw, ref.kind, ref.hint);
      if (next == null || next === raw) return;
      ref.set(next);
      if (ref.kind === 'asset' && !/^https?:/i.test(next)) {
        // Local copies cannot satisfy SRI hashes or CORS mode from file://
        delete ref.el.attribs.integrity;
        delete ref.el.attribs.crossorigin;
      }
    },
    srcset(ref) {
      const candidates = parseSrcset(ref.get());
      let changed = false;
      for (const c of candidates) {
        const next = mapUrl(c.url, 'asset', ref.hint);
        if (next != null && next !== c.url) {
          c.url = next;
          changed = true;
        }
      }
      if (changed) ref.set(serializeSrcset(candidates));
    },
    css(ref) {
      const before = ref.get();
      const after = mapCss(before);
      if (after !== before) ref.set(after);
    },
  });

  if (promoteLazy) {
    $('img, source, iframe').each((_i, el) => {
      const a = el.attribs;
      const src = a.src;
      const placeholder = !src || src.startsWith('data:') || /(?:blank|placeholder|spacer|transparent|lazy)[^/]*\.(?:gif|png|svg)$/i.test(src);
      if (placeholder && el.name !== 'source') {
        const lazy = LAZY_SRC_ATTRS.find((n) => a[n]);
        if (lazy) a.src = a[lazy];
      }
      if (!a.srcset) {
        const lazySet = LAZY_SRCSET_ATTRS.find((n) => a[n]);
        if (lazySet) a.srcset = a[lazySet];
      }
    });
  }

  if (removeScripts) {
    $('script').each((_i, el) => {
      const type = String(el.attribs.type || '').toLowerCase();
      if (!JSON_SCRIPT_TYPES.has(type)) $(el).remove();
    });
    $('link').each((_i, el) => {
      const rels = String(el.attribs.rel || '').toLowerCase();
      if (/\bmodulepreload\b/.test(rels) || (/\bpreload\b/.test(rels) && String(el.attribs.as).toLowerCase() === 'script')) $(el).remove();
    });
  }

  // References are now either local-relative or absolute: <base> would break them.
  $('base').remove();
  // Content-Security-Policy meta tags would block local resources.
  $('meta[http-equiv]').each((_i, el) => {
    const equiv = String(el.attribs['http-equiv']).toLowerCase();
    if (equiv === 'content-security-policy' || equiv === 'content-type') $(el).remove();
  });
  // Output is always written as UTF-8.
  $('meta[charset]').remove();
  const head = $('head');
  if (head.length) head.prepend('<meta charset="utf-8">');

  return { html: $.html(), stats };
}
