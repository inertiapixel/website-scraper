/**
 * Job operations shared by the CLI commands.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JobStatus, ACTIVE_STATUSES, RESUMABLE_STATUSES } from './states.js';
import { verifyWorker, signalWorker } from './process.js';
import { HEARTBEAT_MS, LEASE_MS } from './constants.js';
import { PACKAGE_ROOT } from '../config/load.js';
import { validateStartUrl } from '../url/normalize.js';
import { hostDirName } from '../output/paths.js';
import { createJobId, createToken } from '../util/ids.js';
import { UsageError, StateError } from '../util/errors.js';
import { sleep } from '../util/time.js';

const S = JobStatus;
export const WORKER_ENTRY = path.join(PACKAGE_ROOT, 'bin', 'website-scraper-worker.js');
const DISPATCH_TIMEOUT_MS = 30_000;

/** State directory (job database, logs, staging). */
export function resolveHome() {
  return path.resolve(process.env.WEBSITE_SCRAPER_HOME || '.website-scraper');
}

/**
 * Create a job from an effective configuration. The configuration is
 * snapshotted into the job, so later edits to scraper.config.json never
 * change an existing job.
 */
export function createJob(store, { config, mode, home }) {
  const start = validateStartUrl(config.website.startUrl);
  const snapshot = structuredClone(config);
  snapshot.website.startUrl = start.href;
  snapshot.output.baseDir = path.resolve(config.output.baseDir);

  let id;
  let outputDir;
  for (let attempt = 0; ; attempt++) {
    id = createJobId();
    outputDir = path.join(snapshot.output.baseDir, hostDirName(start), id);
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    try {
      fs.mkdirSync(outputDir); // exclusive: never reuse another job's directory
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' || attempt > 5) throw err;
    }
  }
  const jobDir = path.join(home, 'jobs', id);
  fs.mkdirSync(jobDir, { recursive: true });
  return store.createJob({
    id,
    start_url: start.href,
    hostname: start.hostname,
    mode,
    config_json: JSON.stringify(snapshot),
    output_dir: outputDir,
    job_dir: jobDir,
    log_path: path.join(jobDir, 'worker.log'),
  });
}

/** Issue a one-time dispatch token for a QUEUED job; only its holder may claim the job. */
export function dispatch(store, jobId, mode) {
  const token = createToken();
  const ok = store.tx(() => {
    const job = store.getJob(jobId);
    if (!job || job.status !== S.QUEUED) return false;
    store.updateJob(jobId, { dispatch_token: token, dispatched_at: Date.now(), mode });
    return true;
  });
  if (!ok) throw new StateError(`Job ${jobId} is not queued`);
  return token;
}

/** Start a detached worker process whose stdout/stderr go to the job log. */
export async function spawnBackgroundWorker({ job, home, dispatchToken }) {
  fs.mkdirSync(path.dirname(job.log_path), { recursive: true });
  const fd = fs.openSync(job.log_path, 'a');
  try {
    fs.writeSync(fd, `${new Date().toISOString()} [INFO] Starting background worker for ${job.id}\n`);
    const child = spawn(process.execPath, [WORKER_ENTRY, '--job', job.id], {
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: process.cwd(),
      env: { ...process.env, WEBSITE_SCRAPER_HOME: home, WEBSITE_SCRAPER_DISPATCH_TOKEN: dispatchToken },
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    let exitCode = null;
    child.once('exit', (code, signal) => {
      exitCode = code ?? signal;
    });
    child.unref();
    return { pid: child.pid, exitCode: () => exitCode };
  } finally {
    fs.closeSync(fd);
  }
}

/** Wait until the worker has claimed the job (or exited / timed out). */
export async function waitForClaim(store, jobId, { timeoutMs = 15_000, exitCode = () => null } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const job = store.getJob(jobId);
    if (job.status !== S.QUEUED || !job.dispatch_token) return { job, claimed: job.status !== S.QUEUED };
    if (exitCode() !== null) return { job, claimed: false, exited: exitCode() };
    if (Date.now() > end) return { job, claimed: false };
    await sleep(100);
  }
}

/**
 * Detect workers that died without updating their job (crash, kill -9,
 * reboot) and mark those jobs INTERRUPTED so they can be resumed.
 */
export function recoverStaleJobs(store) {
  const recovered = [];
  const now = Date.now();
  for (const job of store.jobsWithStatus([S.QUEUED, ...ACTIVE_STATUSES])) {
    if (job.status === S.QUEUED) {
      if (job.dispatch_token && job.dispatched_at && now - job.dispatched_at > DISPATCH_TIMEOUT_MS) {
        const ok = store.transition(job.id, [S.QUEUED], S.INTERRUPTED, {
          dispatch_token: null, status_reason: 'Worker did not start; see the job log', current_activity: 'Interrupted',
        });
        if (ok) recovered.push({ id: job.id, reason: 'worker did not start' });
      }
      continue;
    }
    const v = verifyWorker(job);
    let reason = null;
    if (v.state === 'dead' || v.state === 'mismatch' || v.state === 'none') reason = v.detail;
    else if ((v.state === 'remote' || v.state === 'unverifiable') && job.lease_expires_at && now > job.lease_expires_at + LEASE_MS) {
      reason = `lease expired at ${new Date(job.lease_expires_at).toISOString()}`;
    }
    if (!reason) continue;
    const ok = store.transition(job.id, [job.status], S.INTERRUPTED, {
      status_reason: `Worker stopped unexpectedly: ${reason}`, current_activity: 'Interrupted', worker_token: null, lease_expires_at: null,
    }, { expectToken: job.worker_token });
    if (ok) {
      store.resetInFlight(job.id);
      recovered.push({ id: job.id, reason });
    }
  }
  return recovered;
}

/** Human-readable worker health. */
export function workerHealth(job) {
  if (!ACTIVE_STATUSES.includes(job.status)) {
    if (job.status === S.QUEUED && job.dispatch_token) return { ok: true, label: 'starting' };
    return { ok: true, label: 'not running' };
  }
  const v = verifyWorker(job);
  const age = job.heartbeat_at ? Math.round((Date.now() - job.heartbeat_at) / 1000) : null;
  if (v.state === 'verified' || v.state === 'unverifiable' || v.state === 'remote') {
    if (age != null && age * 1000 > HEARTBEAT_MS * 4) return { ok: false, label: `unresponsive (pid ${job.worker_pid}, last heartbeat ${age}s ago)` };
    return { ok: true, label: `healthy (pid ${job.worker_pid}, heartbeat ${age ?? '?'}s ago)` };
  }
  return { ok: false, label: `stale: ${v.detail}` };
}

async function waitForStatus(store, jobId, statuses, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const job = store.getJob(jobId);
    if (statuses.includes(job.status)) return job;
    if (Date.now() > end) return null;
    recoverStaleJobs(store);
    await sleep(250);
  }
}

/**
 * Request a graceful stop. Returns the final job row (or the current row if
 * the wait timed out) and a message describing what happened.
 */
export async function stopJob(store, jobId, { waitMs = 60_000, force = false } = {}) {
  recoverStaleJobs(store);
  let job = store.getJob(jobId);
  if (!job) throw new UsageError(`Job ${jobId} not found`);
  if ([S.COMPLETED, S.STOPPED, S.FAILED].includes(job.status)) return { job, message: `Job is already ${job.status}` };
  if ([S.QUEUED, S.PAUSED, S.INTERRUPTED].includes(job.status)) {
    if (!store.transition(jobId, [job.status], S.STOPPED, { status_reason: 'Stopped by user', dispatch_token: null, current_activity: 'Stopped' })) {
      throw new StateError('Job state changed while stopping; try again');
    }
    return { job: store.getJob(jobId), message: 'Job stopped' };
  }
  if (job.status !== S.STOPPING) {
    if (!store.transition(jobId, [job.status], S.STOPPING, { status_reason: 'Stopped by user' })) {
      throw new StateError('Job state changed while stopping; try again');
    }
  }
  job = store.getJob(jobId);
  const sig = signalWorker(job, 'SIGTERM');
  const final = await waitForStatus(store, jobId, [S.STOPPED, S.FAILED, S.COMPLETED, S.INTERRUPTED], waitMs);
  if (final) {
    if (final.status === S.INTERRUPTED) {
      store.transition(jobId, [S.INTERRUPTED], S.STOPPED, { status_reason: 'Stopped by user', current_activity: 'Stopped' });
    }
    return { job: store.getJob(jobId), message: 'Job stopped', signal: sig };
  }
  if (force) {
    const killed = signalWorker(store.getJob(jobId), 'SIGKILL');
    await sleep(500);
    recoverStaleJobs(store);
    const cur = store.getJob(jobId);
    if (cur.status === S.INTERRUPTED) store.transition(jobId, [S.INTERRUPTED], S.STOPPED, { status_reason: 'Force-stopped by user', current_activity: 'Stopped' });
    return { job: store.getJob(jobId), message: killed.sent ? 'Worker killed; job marked STOPPED' : `Could not kill worker: ${killed.detail}` };
  }
  return { job: store.getJob(jobId), message: `Stop requested; the worker is still finishing (waited ${Math.round(waitMs / 1000)}s). Use --force to kill it.`, timedOut: true };
}

export async function pauseJob(store, jobId, { waitMs = 60_000 } = {}) {
  recoverStaleJobs(store);
  const job = store.getJob(jobId);
  if (!job) throw new UsageError(`Job ${jobId} not found`);
  if (![S.STARTING, S.RUNNING].includes(job.status)) return { job, message: `Only running jobs can be paused (job is ${job.status})` };
  if (!store.transition(jobId, [job.status], S.PAUSING, { status_reason: 'Paused by user' })) {
    throw new StateError('Job state changed while pausing; try again');
  }
  signalWorker(store.getJob(jobId), 'SIGTERM');
  const final = await waitForStatus(store, jobId, [S.PAUSED, S.STOPPED, S.FAILED, S.COMPLETED, S.INTERRUPTED], waitMs);
  return final ? { job: final, message: `Job ${final.status}` } : { job: store.getJob(jobId), message: 'Pause requested; the worker is still finishing', timedOut: true };
}

/** Move a resumable job back to QUEUED and issue a dispatch token. */
export function prepareResume(store, jobId, { mode, retryFailed = false }) {
  recoverStaleJobs(store);
  const job = store.getJob(jobId);
  if (!job) throw new UsageError(`Job ${jobId} not found`);
  if (job.status === S.COMPLETED) throw new UsageError(`Job ${jobId} is already COMPLETED. Start a new job to capture the site again.`);
  if (job.status === S.QUEUED || ACTIVE_STATUSES.includes(job.status)) {
    throw new UsageError(`Job ${jobId} is ${job.status}; it already has (or is getting) a worker`);
  }
  if (!RESUMABLE_STATUSES.includes(job.status)) throw new UsageError(`Job ${jobId} cannot be resumed from ${job.status}`);
  const token = createToken();
  const ok = store.tx(() => {
    if (!store.transition(jobId, [job.status], S.QUEUED, {
      dispatch_token: token, dispatched_at: Date.now(), mode, status_reason: `Resumed from ${job.status}`,
      phase: null, current_activity: 'Queued for resume', completed_at: null,
    })) return false;
    if (retryFailed) store.requeueFailed(jobId);
    return true;
  });
  if (!ok) throw new StateError('Job state changed while resuming; try again');
  return { job: store.getJob(jobId), token };
}
