/**
 * Terminal output formatting for CLI commands.
 */
import path from 'node:path';
import { formatDuration, formatTimestamp } from '../util/time.js';
import { workerHealth } from '../jobs/service.js';
import { ACTIVE_STATUSES } from '../jobs/states.js';
import { redactUrl } from '../url/normalize.js';

export const TITLE = 'Website Scraper';

/** Show a path relative to the current directory when it is inside it. */
export function displayPath(p, { dir = false } = {}) {
  const rel = path.relative(process.cwd(), p);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
  return dir ? `${shown.replace(/\/+$/, '')}/` : shown;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function truncate(s, n) {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function elapsedOf(job) {
  if (!job.started_at) return null;
  const end = job.completed_at || (ACTIVE_STATUSES.includes(job.status) ? Date.now() : job.updated_at);
  return end - job.started_at;
}

/** Collect everything the status command shows (also used for --json). */
export function jobSnapshot(store, job) {
  const pages = store.pageCounts(job.id);
  const assets = store.assetCounts(job.id);
  const health = workerHealth(job);
  const start = store.startPage(job.id);
  return {
    id: job.id,
    url: job.start_url,
    hostname: job.hostname,
    status: job.status,
    statusReason: job.status_reason,
    mode: job.mode,
    createdAt: job.created_at,
    startedAt: job.started_at,
    updatedAt: job.updated_at,
    completedAt: job.completed_at,
    elapsedMs: elapsedOf(job),
    runs: job.run_count,
    worker: { pid: job.worker_pid, host: job.worker_host, heartbeatAt: job.heartbeat_at, health: health.label, healthy: health.ok },
    activity: ACTIVE_STATUSES.includes(job.status) ? job.current_activity : null,
    inProgress: store.processingPages(job.id, 5).map((p) => p.fetch_url),
    pages,
    assets,
    topSkipReasons: store.topReasons(job.id, 'pages', 'SKIPPED', 3),
    topFailureReasons: [...store.topReasons(job.id, 'pages', 'FAILED', 3), ...store.topReasons(job.id, 'assets', 'FAILED', 3)],
    lastError: job.last_error,
    outputDir: job.output_dir,
    entryPage: start?.status === 'COMPLETED' && start.local_path ? path.join(job.output_dir, start.local_path) : null,
    logPath: job.log_path,
  };
}

export function renderStatus(snap) {
  const lines = [];
  const row = (k, v) => lines.push(`${pad(`${k}:`, 13)}${v}`);
  lines.push(`${TITLE} - job status`, '');
  row('Job ID', snap.id);
  row('Website', snap.url);
  row('Status', `${snap.status}${snap.statusReason ? `  (${snap.statusReason})` : ''}`);
  row('Mode', snap.mode);
  row('Worker', snap.worker.health);
  row('Created', formatTimestamp(snap.createdAt));
  row('Started', formatTimestamp(snap.startedAt));
  row('Completed', formatTimestamp(snap.completedAt));
  row('Elapsed', formatDuration(snap.elapsedMs));
  if (snap.runs > 1) row('Runs', `${snap.runs} (resumed ${snap.runs - 1} time${snap.runs > 2 ? 's' : ''})`);
  if (snap.activity) row('Activity', truncate(redactUrl(snap.activity), 110));
  if (snap.inProgress.length) row('In progress', snap.inProgress.map((u) => truncate(redactUrl(u), 90)).join('\n             '));
  const p = snap.pages;
  const a = snap.assets;
  lines.push('', 'Pages');
  lines.push(`  Discovered ${p.discovered}   Queued ${p.queued}   Processing ${p.processing}   Completed ${p.completed}   Failed ${p.failed}   Skipped ${p.skipped}`);
  lines.push('Assets');
  lines.push(`  Downloaded ${a.downloaded} (${formatBytes(a.bytes)})   Pending ${a.pending + a.downloading}   Skipped ${a.skipped}   Failed ${a.failed}`);
  if (snap.topSkipReasons.length) {
    lines.push('', 'Top page skip reasons');
    for (const r of snap.topSkipReasons) lines.push(`  ${pad(r.n, 6)} ${r.reason_code}: ${truncate(r.example, 90)}`);
  }
  if (snap.topFailureReasons.length) {
    lines.push('', 'Top failures');
    for (const r of snap.topFailureReasons) lines.push(`  ${pad(r.n, 6)} ${r.reason_code}: ${truncate(r.example, 90)}`);
  }
  lines.push('');
  if (snap.lastError) row('Last error', truncate(redactUrl(snap.lastError), 140));
  row('Output', displayPath(snap.outputDir, { dir: true }));
  if (snap.entryPage) row('Open', displayPath(snap.entryPage));
  row('Log', displayPath(snap.logPath));
  return lines.join('\n');
}

export function renderJobsTable(rows) {
  if (!rows.length) return 'No jobs yet. Start one with: npm run scrape -- https://example.com';
  const header = ['JOB ID', 'STATUS', 'PAGES', 'ASSETS', 'CREATED', 'WEBSITE'];
  const data = rows.map((r) => [
    r.job.id,
    r.job.status,
    `${r.pages.completed}/${r.pages.discovered - r.pages.skipped}`,
    String(r.assets.downloaded),
    formatTimestamp(r.job.created_at),
    truncate(r.job.start_url, 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const fmt = (cols) => cols.map((c, i) => (i === cols.length - 1 ? c : pad(c, widths[i] + 2))).join('');
  return [fmt(header), ...data.map(fmt)].join('\n');
}
