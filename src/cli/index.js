/**
 * CLI entry point: `website-scraper <command> [options]`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { JobStore } from '../jobs/store.js';
import { JobStatus, FINAL_STATUSES } from '../jobs/states.js';
import {
  resolveHome, createJob, dispatch, spawnBackgroundWorker, waitForClaim, recoverStaleJobs, stopJob, pauseJob, prepareResume,
} from '../jobs/service.js';
import { loadConfig, PACKAGE_ROOT } from '../config/load.js';
import { SCRAPE_OPTIONS, parse, overridesFromFlags } from './args.js';
import { TITLE, displayPath, jobSnapshot, renderStatus, renderJobsTable, formatBytes } from './format.js';
import { HELP, COMMAND_HELP } from './help.js';
import { AppError, ConfigError, UsageError } from '../util/errors.js';
import { JOB_ID_PATTERN } from '../util/ids.js';
import { formatDuration } from '../util/time.js';

const out = (s = '') => process.stdout.write(`${s}\n`);
const err = (s = '') => process.stderr.write(`${s}\n`);

function version() {
  return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

function openStore() {
  return JobStore.open(resolveHome());
}

function requireJobId(positionals, command) {
  const id = positionals[0];
  if (!id) throw new UsageError(`Missing job ID. Usage: npm run ${command} -- <JOB_ID>  (list jobs with: npm run jobs)`);
  if (!JOB_ID_PATTERN.test(id)) throw new UsageError(`"${id}" is not a valid job ID (expected something like job_20260101_120000_ab12cd34)`);
  return id;
}

function getJobOrThrow(store, id) {
  const job = store.getJob(id);
  if (!job) throw new UsageError(`Job ${id} not found. List jobs with: npm run jobs`);
  return job;
}

// ---- scrape -------------------------------------------------------------------

async function cmdScrape(argv) {
  const { values, positionals } = parse(argv, SCRAPE_OPTIONS);
  if (values.help) {
    out(COMMAND_HELP.scrape);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError(`Expected one URL, got ${positionals.length}: ${positionals.join(' ')}`);
  if (values.background && values.foreground) throw new UsageError('Use either --background or --foreground');
  const overrides = overridesFromFlags(values, positionals[0]);
  const config = loadConfig({ overlayPaths: values.config ?? [], overrides, requireStartUrl: true });
  if (!config.crawler.respectRobotsTxt) err('Warning: robots.txt compliance is disabled. Only do this for sites you own or are authorized to crawl.');
  if (config.network.allowPrivateNetworks) err('Warning: private/loopback network access is enabled. Use this only for trusted local testing.');

  const home = resolveHome();
  const store = JobStore.open(home);
  const mode = values.background ? 'BACKGROUND' : 'FOREGROUND';
  try {
    recoverStaleJobs(store);
    const job = createJob(store, { config, mode, home });
    const token = dispatch(store, job.id, mode);
    if (mode === 'BACKGROUND') return await startBackground(store, job, token, home, backgroundOptions(values));

    out(`${TITLE}\n`);
    out(`Job ID:  ${job.id}`);
    out(`Website: ${job.start_url}`);
    out(`Mode:    FOREGROUND (Ctrl+C stops gracefully; resume later with npm run job:resume -- ${job.id})`);
    out(`Output:  ${displayPath(job.output_dir, { dir: true })}`);
    out(`Log:     ${displayPath(job.log_path)}\n`);
    store.close();
    return await runForeground(job.id, token, home);
  } finally {
    store.close();
  }
}

async function runForeground(jobId, token, home) {
  const { runWorker } = await import('../jobs/worker.js');
  const result = await runWorker({ home, jobId, dispatchToken: token, mode: 'FOREGROUND' });
  const store = JobStore.open(home);
  try {
    out('');
    printResult(jobSnapshot(store, store.getJob(jobId)));
  } finally {
    store.close();
  }
  return result.exitCode;
}

const RESUMABLE = [JobStatus.STOPPED, JobStatus.PAUSED, JobStatus.INTERRUPTED, JobStatus.FAILED];

/** Final summary of a job, printed when it ends (foreground, --follow, logs --follow). */
function printResult(snap) {
  out(`${TITLE}: job ${snap.status}${snap.statusReason ? ` (${snap.statusReason})` : ''}`);
  out(`Pages:  ${snap.pages.completed} saved, ${snap.pages.failed} failed, ${snap.pages.skipped} skipped`);
  out(`Assets: ${snap.assets.downloaded} downloaded (${formatBytes(snap.assets.bytes)}), ${snap.assets.skipped} skipped, ${snap.assets.failed} failed`);
  out(`Time:   ${formatDuration(snap.elapsedMs)}`);
  out(`Output: ${displayPath(snap.outputDir, { dir: true })}`);
  if (snap.entryPage) out(`Open:   ${displayPath(snap.entryPage)}`);
  if (snap.lastError && snap.status !== JobStatus.COMPLETED) out(`Error:  ${snap.lastError}`);
  out(`Log:    ${displayPath(snap.logPath)}`);
  if (RESUMABLE.includes(snap.status)) out(`Resume: npm run job:resume -- ${snap.id}`);
}

function exitCodeFor(status) {
  if (status === JobStatus.FAILED) return 1;
  if (status === JobStatus.INTERRUPTED) return 2;
  return 0;
}

function backgroundOptions(values) {
  return { json: values.json, follow: values.follow, notify: !values['no-notify'] };
}

/**
 * Terminal device of this CLI (e.g. /dev/ttys003), so the detached worker
 * can print a one-time result notice there when the job ends.
 */
function currentTty() {
  if (process.platform === 'win32' || !process.stdin.isTTY || !process.stdout.isTTY) return null;
  try {
    const tty = execFileSync('tty', [], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000 }).trim();
    return /^\/dev\/(?:ttys?\d+|pts\/\d+)$/.test(tty) ? tty : null;
  } catch {
    return null;
  }
}

/** Wait briefly after start: until the first page is saved, the job ends, or `maxMs` passes. */
async function waitForEarlyOutcome(store, jobId, maxMs = 5000) {
  const end = Date.now() + maxMs;
  for (;;) {
    const job = store.getJob(jobId);
    if (FINAL_STATUSES.includes(job.status)) return job;
    if (store.startPage(jobId)?.status === 'COMPLETED' || Date.now() > end) return job;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function startBackground(store, job, token, home, { json = false, follow = false, notify = true } = {}) {
  const notifyTty = notify && !json ? currentTty() : null;
  const child = await spawnBackgroundWorker({ job, home, dispatchToken: token });
  const { job: claimedJob, claimed, exited } = await waitForClaim(store, job.id, { exitCode: child.exitCode });
  const current = claimed ? await waitForEarlyOutcome(store, job.id) : claimedJob;
  if (json) {
    out(JSON.stringify({ id: job.id, url: job.start_url, status: current.status, mode: 'BACKGROUND', output: job.output_dir, log: job.log_path, workerPid: child.pid }, null, 2));
    return FINAL_STATUSES.includes(current.status) ? exitCodeFor(current.status) : (claimed ? 0 : 1);
  }
  out(`${TITLE}\n`);
  if (FINAL_STATUSES.includes(current.status)) {
    // The job already ended (e.g. the site refused the first request): say so now.
    out(`Background job ${job.id} finished immediately.\n`);
    printResult(jobSnapshot(store, current));
    return exitCodeFor(current.status);
  }
  if (!claimed && current.status === JobStatus.QUEUED) {
    err(exited != null
      ? `The background worker exited before starting (code ${exited}). See the log: ${displayPath(job.log_path)}`
      : 'The background worker has not started yet. Check its status and log below.');
  } else {
    out('Background job created successfully.\n');
  }
  out(`Job ID: ${job.id}`);
  out(`Website: ${job.start_url}`);
  out(`Status: ${current.status}`);
  out('Mode: BACKGROUND');
  out(`Worker PID: ${child.pid}`);
  out(`Output: ${displayPath(job.output_dir, { dir: true })}`);
  out('');
  out('Check status:');
  out(`npm run job:status -- ${job.id}`);
  out('');
  out('View logs:');
  out(`npm run job:logs -- ${job.id}`);
  out('');
  out('Stop:');
  out(`npm run job:stop -- ${job.id}`);
  if (follow) {
    out('\nFollowing progress (Ctrl+C stops following; the job keeps running)...\n');
    return followJob(job.id, { offset: 0, notifyTty });
  }
  if (notifyTty) {
    if (store.setNotifyTtyIfUnfinished(job.id, notifyTty)) {
      out('\nThe result will be printed in this terminal when the job finishes.');
    } else {
      out('');
      printResult(jobSnapshot(store, store.getJob(job.id))); // it ended just now
      return exitCodeFor(store.getJob(job.id).status);
    }
  }
  return claimed || current.status !== JobStatus.QUEUED ? 0 : 1;
}

/**
 * Stream a job's log until the job ends, then print its result. Ctrl+C only
 * stops following; a background job keeps running.
 */
async function followJob(jobId, { offset = 0, notifyTty = null } = {}) {
  const s0 = openStore();
  const job = getJobOrThrow(s0, jobId);
  s0.close();
  let detached = false;
  const onInt = () => {
    detached = true;
  };
  process.on('SIGINT', onInt);
  try {
    let idleSinceFinal = null;
    for (;;) {
      if (detached) {
        const s1 = openStore();
        try {
          if (notifyTty && !s1.setNotifyTtyIfUnfinished(jobId, notifyTty)) {
            out('');
            printResult(jobSnapshot(s1, s1.getJob(jobId)));
            return exitCodeFor(s1.getJob(jobId).status);
          }
        } finally {
          s1.close();
        }
        out(`\nStopped following. The job keeps running in the background: npm run job:status -- ${jobId}`);
        if (notifyTty) out('The result will be printed in this terminal when the job finishes.');
        return 0;
      }
      if (fs.existsSync(job.log_path)) {
        const size = fs.statSync(job.log_path).size;
        if (size > offset) {
          const fd = fs.openSync(job.log_path, 'r');
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          process.stdout.write(buf.toString('utf8'));
          offset = size;
          idleSinceFinal = null;
          continue;
        }
      }
      const s = openStore();
      try {
        recoverStaleJobs(s);
        const cur = s.getJob(jobId);
        if (FINAL_STATUSES.includes(cur.status)) {
          idleSinceFinal ??= Date.now();
          if (Date.now() - idleSinceFinal > 1500) {
            out(`-- job ${cur.status} --\n`);
            printResult(jobSnapshot(s, cur));
            return exitCodeFor(cur.status);
          }
        }
      } finally {
        s.close();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    process.off('SIGINT', onInt);
  }
}

// ---- jobs / status / logs -------------------------------------------------------

async function cmdJobs(argv) {
  const { values } = parse(argv, {
    status: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  }, { positionals: false });
  if (values.help) {
    out(COMMAND_HELP.jobs);
    return 0;
  }
  const status = values.status?.toUpperCase();
  if (status && !Object.values(JobStatus).includes(status)) throw new UsageError(`Unknown status "${values.status}". Valid: ${Object.values(JobStatus).join(', ')}`);
  const limit = values.limit ? Number(values.limit) : 50;
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');
  const store = openStore();
  try {
    recoverStaleJobs(store);
    const rows = store.listJobs({ limit, status }).map((job) => ({ job, pages: store.pageCounts(job.id), assets: store.assetCounts(job.id) }));
    if (values.json) out(JSON.stringify(rows.map((r) => jobSnapshot(store, r.job)), null, 2));
    else out(renderJobsTable(rows));
    return 0;
  } finally {
    store.close();
  }
}

async function cmdStatus(argv) {
  const { values, positionals } = parse(argv, { json: { type: 'boolean' }, watch: { type: 'boolean', short: 'w' }, help: { type: 'boolean', short: 'h' } });
  if (values.help) {
    out(COMMAND_HELP.status);
    return 0;
  }
  const id = requireJobId(positionals, 'job:status');
  const store = openStore();
  try {
    for (;;) {
      recoverStaleJobs(store);
      const snap = jobSnapshot(store, getJobOrThrow(store, id));
      if (values.json) {
        out(JSON.stringify(snap, null, 2));
        return 0;
      }
      if (values.watch && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
      out(renderStatus(snap));
      if (!values.watch || FINAL_STATUSES.includes(snap.status)) return 0;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    store.close();
  }
}

function tailLines(file, n) {
  const stat = fs.statSync(file);
  const chunk = Math.min(stat.size, Math.max(64 * 1024, n * 400));
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, stat.size - chunk);
    const lines = buf.toString('utf8').split('\n');
    if (chunk < stat.size) lines.shift();
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-n), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

async function cmdLogs(argv) {
  const { values, positionals } = parse(argv, {
    follow: { type: 'boolean', short: 'f' }, lines: { type: 'string', short: 'n' }, all: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(COMMAND_HELP.logs);
    return 0;
  }
  const id = requireJobId(positionals, 'job:logs');
  const n = values.all ? Number.MAX_SAFE_INTEGER : values.lines ? Number(values.lines) : 200;
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--lines must be a positive integer');
  const store = openStore();
  let job;
  try {
    job = getJobOrThrow(store, id);
  } finally {
    store.close();
  }
  if (!fs.existsSync(job.log_path)) {
    out(`No log output yet for ${id} (${displayPath(job.log_path)})`);
    if (!values.follow) return 0;
  }
  let offset = 0;
  if (fs.existsSync(job.log_path)) {
    if (values.all) {
      const text = fs.readFileSync(job.log_path, 'utf8');
      process.stdout.write(text);
      offset = Buffer.byteLength(text);
    } else {
      const t = tailLines(job.log_path, n);
      if (t.lines.length) out(t.lines.join('\n'));
      offset = t.size;
    }
  }
  if (!values.follow) return 0;
  return followJob(id, { offset });
}

// ---- stop / pause / resume ---------------------------------------------------------

async function cmdStop(argv) {
  const { values, positionals } = parse(argv, {
    force: { type: 'boolean' }, 'no-wait': { type: 'boolean' }, timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(COMMAND_HELP.stop);
    return 0;
  }
  const id = requireJobId(positionals, 'job:stop');
  const waitMs = values['no-wait'] ? 0 : (values.timeout ? Number(values.timeout) * 1000 : 60_000);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new UsageError('--timeout must be a number of seconds');
  const store = openStore();
  try {
    if (!values['no-wait']) out(`Stopping ${id} (waiting up to ${Math.round(waitMs / 1000)}s for in-flight work to finish)...`);
    const res = await stopJob(store, id, { waitMs, force: values.force });
    out(`${res.message}. Status: ${res.job.status}`);
    if ([JobStatus.STOPPED].includes(res.job.status)) out(`Resume with: npm run job:resume -- ${id}`);
    return res.timedOut ? 1 : 0;
  } finally {
    store.close();
  }
}

async function cmdPause(argv) {
  const { values, positionals } = parse(argv, { timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  if (values.help) {
    out(COMMAND_HELP.pause);
    return 0;
  }
  const id = requireJobId(positionals, 'job:pause');
  const store = openStore();
  try {
    out(`Pausing ${id}...`);
    const res = await pauseJob(store, id, { waitMs: values.timeout ? Number(values.timeout) * 1000 : 60_000 });
    out(`${res.message}. Status: ${res.job.status}`);
    if (res.job.status === JobStatus.PAUSED) out(`Resume with: npm run job:resume -- ${id}`);
    return res.timedOut ? 1 : 0;
  } finally {
    store.close();
  }
}

async function cmdResume(argv) {
  const { values, positionals } = parse(argv, {
    foreground: { type: 'boolean' }, 'retry-failed': { type: 'boolean' }, json: { type: 'boolean' },
    follow: { type: 'boolean', short: 'f' }, 'no-notify': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  });
  if (values.help) {
    out(COMMAND_HELP.resume);
    return 0;
  }
  const id = requireJobId(positionals, 'job:resume');
  const home = resolveHome();
  const store = JobStore.open(home);
  const mode = values.foreground ? 'FOREGROUND' : 'BACKGROUND';
  try {
    getJobOrThrow(store, id);
    const before = { pages: store.pageCounts(id), assets: store.assetCounts(id) };
    const { job, token } = prepareResume(store, id, { mode, retryFailed: values['retry-failed'] });
    const remaining = store.remainingWork(id);
    if (!values.json) {
      out(`Resuming ${id}: ${before.pages.completed} page(s) and ${before.assets.downloaded} asset(s) already captured; ` +
        `${remaining.pages} page(s) and ${remaining.assets} asset(s) remaining.`);
      out('The job keeps its original configuration snapshot.\n');
    }
    if (mode === 'BACKGROUND') return await startBackground(store, job, token, home, backgroundOptions(values));
    store.close();
    return await runForeground(id, token, home);
  } finally {
    store.close();
  }
}

async function cmdConfig(argv) {
  const { values, positionals } = parse(argv, SCRAPE_OPTIONS);
  if (values.help) {
    out(COMMAND_HELP.config);
    return 0;
  }
  const config = loadConfig({ overlayPaths: values.config ?? [], overrides: overridesFromFlags(values, positionals[0]) });
  out(JSON.stringify(config, null, 2));
  err('\nConfiguration is valid.');
  return 0;
}

// ---- main -------------------------------------------------------------------------

const COMMANDS = {
  scrape: cmdScrape,
  jobs: cmdJobs,
  list: cmdJobs,
  status: cmdStatus,
  logs: cmdLogs,
  stop: cmdStop,
  pause: cmdPause,
  resume: cmdResume,
  config: cmdConfig,
};

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      const topic = rest[0];
      out(topic && COMMAND_HELP[topic] ? COMMAND_HELP[topic] : HELP);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      out(version());
      return 0;
    }
    const fn = COMMANDS[command];
    if (!fn) throw new UsageError(`Unknown command "${command}". Run "npm run help" for the list of commands.`);
    return await fn(rest);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(e.message);
      return 2;
    }
    if (e instanceof UsageError || e instanceof AppError) {
      err(`Error: ${e.message}`);
      return 2;
    }
    err(`Unexpected error: ${e?.stack || e}`);
    return 1;
  }
}
