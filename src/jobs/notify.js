/**
 * End-of-job notice for background jobs: a short result message written to
 * the terminal the job was started from (like a shell's "job done" notice).
 * Only real terminal devices are accepted, never arbitrary files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatDuration } from '../util/time.js';
import { redactUrl } from '../url/normalize.js';

const TTY_PATTERN = /^\/dev\/(?:ttys?\d+|pts\/\d+)$/;

function shown(p) {
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

export function buildNotice(store, jobId) {
  const job = store.getJob(jobId);
  const pages = store.pageCounts(jobId);
  const assets = store.assetCounts(jobId);
  const start = store.startPage(jobId);
  const elapsed = job.started_at ? formatDuration((job.completed_at || Date.now()) - job.started_at) : '-';
  const head = job.status === 'COMPLETED'
    ? `[Website Scraper] Job ${job.id} COMPLETED in ${elapsed}`
    : `[Website Scraper] Job ${job.id} ${job.status}${job.status_reason ? `: ${job.status_reason}` : ''}`;
  const lines = [
    head,
    `  ${redactUrl(job.start_url)}  ${pages.completed} page(s) saved, ${pages.failed} failed, ${pages.skipped} skipped; ${assets.downloaded} asset(s) downloaded`,
  ];
  if (job.status === 'COMPLETED' && start?.local_path) lines.push(`  Open: ${shown(path.join(job.output_dir, start.local_path))}`);
  else lines.push(`  Details: npm run job:status -- ${job.id}    Resume: npm run job:resume -- ${job.id}`);
  return `\n${lines.join('\n')}\n`;
}

/** Write `text` to a terminal device. Never throws; returns whether it was written. */
export function notifyTerminal(ttyPath, text) {
  if (!ttyPath || !TTY_PATTERN.test(ttyPath)) return false;
  let fd;
  try {
    // O_NOCTTY: the detached worker must never adopt this terminal as its controlling terminal.
    fd = fs.openSync(ttyPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, text);
    return true;
  } catch {
    return false; // terminal closed or not writable: the result is still in job:status and the log
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
