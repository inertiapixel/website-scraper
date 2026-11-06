/**
 * crawl-report.json writer. Rows are streamed in keyset-paginated batches,
 * so memory stays flat for large crawls, and the file is written to a temp
 * name and renamed into place atomically.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

export const REPORT_NAME = 'crawl-report.json';

const LIMITATIONS = [
  'This is a capture of publicly accessible pages and assets, not a functional clone.',
  'Backend code, databases, APIs, authentication, forms and checkout flows are not reproduced.',
  'Asset URLs generated at runtime by JavaScript (and service workers) cannot be rewritten.',
  'Signed or expiring asset URLs may stop working; dynamic content may differ from the live site.',
];

function pageRow(p) {
  return {
    url: p.fetch_url, normalizedUrl: p.url, finalUrl: p.final_url, status: p.status, depth: p.depth, source: p.source,
    external: Boolean(p.external), httpStatus: p.http_status, contentType: p.content_type, localPath: p.local_path,
    attempts: p.attempts, reasonCode: p.reason_code, reason: p.reason, parentUrl: p.parent_url,
  };
}

function assetRow(a) {
  return {
    url: a.url, finalUrl: a.final_url, status: a.status, category: a.category || a.hint, mime: a.mime, size: a.size,
    localPath: a.local_path, attempts: a.attempts, reasonCode: a.reason_code, reason: a.reason, referrer: a.referrer,
  };
}

async function write(stream, text) {
  if (!stream.write(text)) await once(stream, 'drain');
}

export async function writeReport({ store, job, status, partial = false, extra = {} }) {
  const file = path.join(job.output_dir, REPORT_NAME);
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  const fresh = store.getJob(job.id);
  const pages = store.pageCounts(job.id);
  const assets = store.assetCounts(job.id);
  const start = store.startPage(job.id);
  const header = {
    generator: { name: 'Website Scraper', maintainer: 'Inertia Pixel' },
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    partial,
    job: {
      id: job.id, startUrl: job.start_url, hostname: job.hostname, status, mode: fresh.mode,
      createdAt: new Date(fresh.created_at).toISOString(),
      startedAt: fresh.started_at ? new Date(fresh.started_at).toISOString() : null,
      finishedAt: new Date().toISOString(), runs: fresh.run_count, outputDir: job.output_dir,
      entryPage: start?.status === 'COMPLETED' ? start.local_path : null,
    },
    summary: {
      pages, assets,
      unrecordedUrls: fresh.unrecorded_urls,
      topPageSkipReasons: store.topReasons(job.id, 'pages', 'SKIPPED'),
      topPageFailureReasons: store.topReasons(job.id, 'pages', 'FAILED'),
      topAssetSkipReasons: store.topReasons(job.id, 'assets', 'SKIPPED'),
      topAssetFailureReasons: store.topReasons(job.id, 'assets', 'FAILED'),
      ...extra,
    },
    effectiveConfig: JSON.parse(fresh.config_json),
    limitations: LIMITATIONS,
  };

  await fsp.mkdir(job.output_dir, { recursive: true });
  const stream = fs.createWriteStream(tmp);
  try {
    const head = JSON.stringify(header, null, 2);
    await write(stream, `${head.slice(0, -2)},\n  "pages": [`);
    let after = 0;
    let first = true;
    for (;;) {
      const batch = store.pagesBatch(job.id, after);
      if (!batch.length) break;
      for (const p of batch) {
        await write(stream, `${first ? '\n' : ',\n'}    ${JSON.stringify(pageRow(p))}`);
        first = false;
      }
      after = batch[batch.length - 1].id;
    }
    await write(stream, '\n  ],\n  "assets": [');
    after = 0;
    first = true;
    for (;;) {
      const batch = store.assetsBatch(job.id, after);
      if (!batch.length) break;
      for (const a of batch) {
        await write(stream, `${first ? '\n' : ',\n'}    ${JSON.stringify(assetRow(a))}`);
        first = false;
      }
      after = batch[batch.length - 1].id;
    }
    await write(stream, '\n  ]\n}\n');
    stream.end();
    await once(stream, 'finish');
    await fsp.rename(tmp, file);
  } catch (err) {
    stream.destroy();
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return file;
}
