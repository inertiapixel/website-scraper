/**
 * Offline output generation ("materialize").
 *
 * During the crawl, pages and stylesheets are staged unmodified. This pass
 * runs once their outcome is known (job completion, or a stop for partial
 * output) and rewrites references only to files that were actually
 * captured: anything skipped or failed becomes an absolute URL instead.
 * It reads from staging every time, so it is idempotent and safe to repeat
 * after a resume.
 */
import fsp from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { rewriteHtml, relativeHref } from '../content/html.js';
import { rewriteCss } from '../content/css.js';
import { decodeCssBuffer } from '../content/encoding.js';
import { createPageNormalizer, normalizeAssetUrl, isIgnoredReference } from '../url/normalize.js';
import { safeJoin } from '../output/paths.js';
import { atomicWriteFile } from '../util/fs.js';
import { PageStatus } from '../jobs/states.js';
import { stagingPagePath, stagingCssPath } from './crawler.js';

export function createResolvers(store, job, config) {
  const normalizePage = createPageNormalizer(config.crawler);
  const resolveAsset = (u) => {
    const n = normalizeAssetUrl(u.href);
    return n.ok ? store.resolveDownloadedAsset(job.id, n.key) : null;
  };
  const resolvePage = (u) => {
    const n = normalizePage(u.href);
    const page = n.ok ? store.resolveCompletedPage(job.id, n.key) : null;
    // Links to files (PDFs, images...) point at the downloaded copy.
    return page ?? resolveAsset(u);
  };
  return { resolvePage, resolveAsset };
}

/**
 * @returns {Promise<{ completed: boolean, pages: number, stylesheets: number, missing: number }>}
 */
export async function materialize({ store, job, config, logger, shouldStop = () => false, onProgress = () => {} }) {
  const { resolvePage, resolveAsset } = createResolvers(store, job, config);
  const out = config.output;
  const result = { completed: false, pages: 0, stylesheets: 0, missing: 0 };

  const pageIds = store.pageIdsWithStatus(job.id, PageStatus.COMPLETED);
  for (const id of pageIds) {
    if (shouldStop()) return result;
    const page = store.getPage(id);
    let raw;
    try {
      raw = await fsp.readFile(stagingPagePath(job, id), 'utf8');
    } catch {
      result.missing++;
      logger.warn(`Staged HTML missing for ${page.url}; page not written`);
      continue;
    }
    const html = out.rewriteUrls
      ? rewriteHtml(raw, {
        pageUrl: page.final_url || page.fetch_url,
        localPath: page.local_path,
        resolvePage,
        resolveAsset,
        removeScripts: out.removeScripts,
        promoteLazy: config.crawler.lazyLoad.promoteDataAttributes,
      }).html
      : raw;
    await atomicWriteFile(safeJoin(job.output_dir, page.local_path), html, { encoding: 'utf8' });
    result.pages++;
    if (result.pages % 25 === 0) {
      onProgress(`Writing pages (${result.pages}/${pageIds.length})`);
      await yieldToLoop();
    }
  }

  if (out.rewriteUrls) {
    for (const id of store.stagedStylesheetIds(job.id)) {
      if (shouldStop()) return result;
      const asset = store.getAsset(id);
      let buf;
      try {
        buf = await fsp.readFile(stagingCssPath(job, id));
      } catch {
        result.missing++;
        continue;
      }
      const base = asset.final_url || asset.url;
      const { text, encoding } = decodeCssBuffer(buf);
      const rewritten = rewriteCss(text, (ref) => {
        if (isIgnoredReference(ref.value)) return null;
        let u;
        try {
          u = new URL(ref.value, base);
        } catch {
          return null;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        const local = resolveAsset(u);
        return local ? relativeHref(asset.local_path, local) + u.hash : u.href;
      });
      await atomicWriteFile(safeJoin(job.output_dir, asset.local_path), Buffer.from(rewritten, encoding === 'utf8' ? 'utf8' : 'latin1'));
      result.stylesheets++;
      if (result.stylesheets % 25 === 0) await yieldToLoop();
    }
  }
  result.completed = true;
  return result;
}
