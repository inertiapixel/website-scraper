/**
 * Worker runtime: executes one run of a job, in the foreground CLI process
 * or in a detached background process.
 *
 *  - Claims the job with a compare-and-set lease (prevents duplicate workers).
 *  - Heartbeats every few seconds; polls for STOPPING/PAUSING requests.
 *  - SIGTERM/SIGINT trigger a graceful stop; a second signal forces exit.
 *  - Uncaught exceptions / unhandled rejections mark the job FAILED.
 *  - An unexpected exit marks the job INTERRUPTED (synchronous SQLite write).
 *  - COMPLETED is only set after all work is done and finalization succeeded.
 */
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './store.js';
import { JobStatus, ACTIVE_STATUSES, canTransition } from './states.js';
import { currentProcessStartedAt } from './process.js';
import { LEASE_MS, HEARTBEAT_MS } from './constants.js';
import { Crawler } from '../crawl/crawler.js';
import { materialize } from '../crawl/materialize.js';
import { writeReport } from '../output/report.js';
import { Logger } from '../logging/logger.js';
import { createToken } from '../util/ids.js';
import { describeError } from '../util/errors.js';
import { removeQuietly } from '../util/fs.js';
import { formatDuration } from '../util/time.js';

export { LEASE_MS, HEARTBEAT_MS };

const S = JobStatus;

/**
 * @param {object} opts
 * @param {string} opts.home state directory
 * @param {string} opts.jobId
 * @param {string} opts.dispatchToken token issued when the job was queued
 * @param {'FOREGROUND'|'BACKGROUND'} opts.mode
 * @param {boolean} [opts.handleSignals] install process-level handlers (off in tests)
 * @param {boolean} [opts.consoleOutput] mirror log lines to the terminal (foreground)
 * @param {object} [opts.deps] test hooks forwarded to the crawler
 * @returns {Promise<{ exitCode: number, status: string|null, error?: string }>}
 */
export async function runWorker({ home, jobId, dispatchToken, mode, handleSignals = true, consoleOutput, deps = {} }) {
  const store = JobStore.open(home);
  const initial = store.getJob(jobId);
  if (!initial) {
    store.close();
    return { exitCode: 1, status: null, error: `Job ${jobId} not found` };
  }
  const config = JSON.parse(initial.config_json);
  const logger = mode === 'BACKGROUND'
    ? new Logger({ stream: process.stdout, level: config.logging.level })
    : new Logger({ filePath: initial.log_path, console: consoleOutput ?? true, level: config.logging.level });

  const token = createToken();
  const claimed = store.claimJob(jobId, {
    dispatchToken,
    workerToken: token,
    pid: process.pid,
    host: os.hostname(),
    processStartedAt: currentProcessStartedAt(),
    leaseMs: LEASE_MS,
  });
  if (!claimed) {
    const cur = store.getJob(jobId);
    const msg = `Worker not started: job ${jobId} is ${cur.status}` +
      (cur.worker_pid && ACTIVE_STATUSES.includes(cur.status) ? ` and owned by worker pid ${cur.worker_pid}` : '') +
      '. Only one worker may run a job at a time.';
    logger.error(msg);
    logger.close();
    store.close();
    return { exitCode: 3, status: cur.status, error: msg };
  }

  logger.info(`Worker started: pid ${process.pid}, run #${claimed.run_count}, mode ${mode}`);
  logger.info(`Target: ${claimed.start_url}`);
  logger.info(`Output: ${claimed.output_dir}`);

  let crawler = null;
  let stopKind = null;
  let signalCount = 0;
  let finished = false;

  const request = (kind, why) => {
    if (!stopKind) {
      stopKind = kind;
      logger.info(`${kind === 'pause' ? 'Pause' : kind === 'stop' ? 'Stop' : kind === 'lost' ? 'Lease lost' : 'Interrupt'} requested${why ? ` (${why})` : ''}; finishing in-flight work`);
    }
    crawler?.requestStop(kind);
  };

  /** Synchronous status write used from signal/exit handlers. */
  const markSync = (to, reason, extra = {}) => {
    try {
      const from = ACTIVE_STATUSES.filter((s) => canTransition(s, to));
      store.transition(jobId, from, to, {
        worker_token: null, lease_expires_at: null, current_activity: reason, status_reason: reason, ...extra,
      }, { expectToken: token });
    } catch {
      /* the database may already be closed */
    }
  };

  const onSignal = (sig) => {
    signalCount++;
    if (signalCount > 1) {
      logger.warn(`Received ${sig} again; exiting immediately. Progress is saved and the job can be resumed.`);
      store.resetInFlight(jobId);
      markSync(S.INTERRUPTED, `Forced exit after repeated ${sig}`);
      finished = true;
      process.exit(130);
    }
    let status = null;
    try {
      status = store.getJob(jobId)?.status;
    } catch {
      /* ignore */
    }
    if (status === S.STOPPING) request('stop', sig);
    else if (status === S.PAUSING) request('pause', sig);
    else if (mode === 'FOREGROUND' && sig === 'SIGINT') {
      store.transition(jobId, [S.STARTING, S.RUNNING, S.PAUSING], S.STOPPING, { status_reason: 'Stopped from the terminal (Ctrl+C)' }, { expectToken: token });
      logger.info('Stopping gracefully. Press Ctrl+C again to force an immediate exit.');
      request('stop', sig);
    } else {
      request('interrupt', sig);
    }
  };
  const onFatal = (err) => {
    logger.error(`Fatal worker error: ${err?.stack || err}`);
    markSync(S.FAILED, `Worker crashed: ${describeError(err)}`, { last_error: describeError(err) });
    finished = true;
    const done = () => process.exit(1);
    setTimeout(done, 5000).unref();
    (crawler ? crawler.close() : Promise.resolve()).finally(done);
  };
  const onExit = () => {
    if (!finished) markSync(S.INTERRUPTED, 'Worker process exited unexpectedly');
  };
  const onHup = () => logger.info('Ignoring SIGHUP (terminal closed); the worker keeps running');

  if (handleSignals) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    if (mode === 'BACKGROUND') process.on('SIGHUP', onHup);
    process.on('uncaughtException', onFatal);
    process.on('unhandledRejection', onFatal);
    process.on('exit', onExit);
  }

  const heartbeat = setInterval(() => {
    try {
      const row = store.heartbeat(jobId, token, LEASE_MS);
      if (!row) {
        logger.error('This worker no longer holds the job lease; stopping without further status changes');
        request('lost');
        return;
      }
      if (row.status === S.STOPPING) request('stop', 'requested via CLI');
      else if (row.status === S.PAUSING) request('pause', 'requested via CLI');
    } catch (err) {
      logger.warn(`Heartbeat failed: ${describeError(err)}`);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const runStart = Date.now();
  let exitCode = 0;
  let finalStatus = null;
  const setActivity = (text) => store.updateJob(jobId, { current_activity: text }, { expectToken: token });
  const finishFields = (activity, reason = null) => ({
    phase: null, current_activity: activity, status_reason: reason, worker_token: null, lease_expires_at: null,
  });

  async function finishInterrupted(kind) {
    const job = store.getJob(jobId);
    if (kind === 'stop' || kind === 'pause') {
      const requested = kind === 'stop' ? S.STOPPING : S.PAUSING;
      let cur = store.getJob(jobId).status;
      if (cur === S.STARTING || cur === S.RUNNING) store.transition(jobId, [cur], requested, {}, { expectToken: token });
      setActivity('Writing partial offline copy');
      const mat = await materialize({ store, job, config, logger, shouldStop: () => signalCount > 1 });
      cur = store.getJob(jobId).status;
      // A stop request always wins over a pause request.
      const to = cur === S.STOPPING || kind === 'stop' ? S.STOPPED : S.PAUSED;
      if (cur === S.PAUSING && to === S.STOPPED) store.transition(jobId, [S.PAUSING], S.STOPPING, {}, { expectToken: token });
      if (config.output.generateReport) {
        await writeReport({ store, job, status: to, partial: true })
          .catch((err) => logger.warn(`Could not write partial report: ${describeError(err)}`));
      }
      const from = to === S.STOPPED ? S.STOPPING : S.PAUSING;
      const reason = store.getJob(jobId).status_reason;
      store.transition(jobId, [from], to, finishFields(to === S.STOPPED ? 'Stopped' : 'Paused', reason), { expectToken: token });
      logger.info(`${to === S.STOPPED ? 'Stopped' : 'Paused'}; wrote ${mat.pages} page(s) so far. Resume with: npm run job:resume -- ${jobId}`);
      return to;
    }
    // External termination (e.g. SIGTERM from the OS): save quickly and exit.
    store.transition(jobId, [S.STARTING, S.RUNNING, S.PAUSING, S.STOPPING], S.INTERRUPTED,
      finishFields('Interrupted', 'Worker received a termination signal'), { expectToken: token });
    logger.info(`Interrupted; progress saved. Resume with: npm run job:resume -- ${jobId}`);
    return S.INTERRUPTED;
  }

  async function finishCompleted() {
    store.updateJob(jobId, { phase: 'FINALIZING', current_activity: 'Writing offline copy' }, { expectToken: token });
    const remaining = store.remainingWork(jobId);
    if (remaining.total) {
      throw new Error(`Cannot complete: ${remaining.pages} page(s) and ${remaining.assets} asset(s) are still pending`);
    }
    const job = store.getJob(jobId);
    const mat = await materialize({
      store, job, config, logger, shouldStop: () => Boolean(stopKind), onProgress: (t) => setActivity(t),
    });
    if (!mat.completed) return finishInterrupted(stopKind);
    if (mat.missing) throw new Error(`${mat.missing} staged file(s) are missing; output is incomplete`);

    const pages = store.pageCounts(jobId);
    if (pages.completed === 0) {
      const start = store.startPage(jobId);
      const why = start ? `${start.status.toLowerCase()} (${start.reason || start.reason_code || 'no details'})` : 'was not recorded';
      if (config.output.generateReport) await writeReport({ store, job, status: S.FAILED }).catch(() => {});
      throw new Error(`No pages were captured: the starting page ${why}`);
    }
    if (config.output.generateReport) await writeReport({ store, job, status: S.COMPLETED });

    const ok = store.transition(jobId, [S.RUNNING], S.COMPLETED, { ...finishFields('Completed'), completed_at: Date.now() }, { expectToken: token });
    if (!ok) {
      // A stop/pause request arrived during finalization. All work is done, so
      // a later resume will simply finalize again and complete.
      const cur = store.getJob(jobId).status;
      const to = cur === S.PAUSING ? S.PAUSED : S.STOPPED;
      store.transition(jobId, [cur], to, finishFields(to === S.PAUSED ? 'Paused' : 'Stopped'), { expectToken: token });
      return to;
    }
    await removeQuietly(path.join(job.output_dir, '.tmp'));
    if (!config.output.keepStaging) await removeQuietly(path.join(job.job_dir, 'staging'));
    const assets = store.assetCounts(jobId);
    logger.info(
      `Completed in ${formatDuration(Date.now() - runStart)}: ${pages.completed} page(s) saved, ${pages.failed} failed, ${pages.skipped} skipped; ` +
      `${assets.downloaded} asset(s) downloaded, ${assets.skipped} skipped, ${assets.failed} failed`,
    );
    return S.COMPLETED;
  }

  try {
    if (!store.transition(jobId, [S.STARTING], S.RUNNING, { current_activity: 'Running' }, { expectToken: token })) {
      const status = store.getJob(jobId).status;
      if (status === S.STOPPING) request('stop', 'requested before start');
      else if (status === S.PAUSING) request('pause', 'requested before start');
      else throw new Error(`Unexpected job status ${status} after claim`);
    }
    const reset = store.resetInFlight(jobId);
    if (reset.pages || reset.assets) logger.info(`Recovered ${reset.pages} page(s) and ${reset.assets} asset(s) that were in progress`);

    crawler = new Crawler({ job: store.getJob(jobId), config, store, logger, deps });
    if (stopKind) crawler.requestStop(stopKind);
    const outcome = await crawler.run();
    await crawler.close();

    if (stopKind === 'lost') {
      exitCode = 2;
    } else if (outcome === 'finished' && !stopKind) {
      finalStatus = await finishCompleted();
    } else {
      finalStatus = await finishInterrupted(stopKind);
    }
    if (finalStatus === S.INTERRUPTED) exitCode = 2;
  } catch (err) {
    logger.error(`Job failed: ${err?.stack || err}`);
    store.transition(jobId, [S.STARTING, S.RUNNING, S.PAUSING, S.STOPPING], S.FAILED, {
      ...finishFields('Failed', describeError(err)), last_error: describeError(err),
    }, { expectToken: token });
    finalStatus = S.FAILED;
    exitCode = 1;
  } finally {
    clearInterval(heartbeat);
    finished = true;
    if (crawler) await crawler.close().catch(() => {});
    if (handleSignals) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      process.off('SIGHUP', onHup);
      process.off('uncaughtException', onFatal);
      process.off('unhandledRejection', onFatal);
      process.off('exit', onExit);
    }
    logger.close();
    store.close();
  }
  return { exitCode, status: finalStatus };
}
