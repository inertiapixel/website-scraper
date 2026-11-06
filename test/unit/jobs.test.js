import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JobStore } from '../../src/jobs/store.js';
import { JobStatus as S, TRANSITIONS, canTransition, predecessorsOf } from '../../src/jobs/states.js';
import { createJob, dispatch, recoverStaleJobs, prepareResume, stopJob } from '../../src/jobs/service.js';
import { verifyWorker, isPidAlive, currentProcessStartedAt } from '../../src/jobs/process.js';
import { StateError, UsageError } from '../../src/util/errors.js';
import { loadConfig } from '../../src/config/load.js';
import { tempDir } from '../helpers/fixtures.js';

function setup() {
  const home = tempDir('ws-home-');
  const store = JobStore.open(home);
  const config = loadConfig({ overrides: { website: { startUrl: 'https://xyz.com/' }, output: { baseDir: path.join(home, 'out') } } });
  return { home, store, config, make: () => createJob(store, { config, mode: 'BACKGROUND', home }) };
}

describe('state machine', () => {
  test('defines every required status and valid transitions', () => {
    for (const s of ['QUEUED', 'STARTING', 'RUNNING', 'PAUSING', 'PAUSED', 'STOPPING', 'STOPPED', 'COMPLETED', 'FAILED', 'INTERRUPTED']) {
      assert.ok(TRANSITIONS[s], s);
    }
    assert.equal(canTransition(S.RUNNING, S.COMPLETED), true);
    assert.equal(canTransition(S.QUEUED, S.COMPLETED), false, 'cannot complete without running');
    assert.equal(canTransition(S.STOPPING, S.COMPLETED), false);
    assert.equal(canTransition(S.COMPLETED, S.QUEUED), false, 'completed is terminal');
    assert.deepEqual(predecessorsOf(S.COMPLETED), [S.RUNNING]);
  });
});

describe('job store', () => {
  test('creates jobs with isolated output directories and a config snapshot', () => {
    const { store, make, config } = setup();
    const a = make();
    const b = make();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.output_dir, b.output_dir);
    assert.ok(fs.existsSync(a.output_dir) && fs.existsSync(b.output_dir));
    assert.match(a.output_dir, /out\/xyz\.com\/job_\d{8}_\d{6}_[0-9a-f]{8}$/);
    assert.equal(a.status, S.QUEUED);
    const snap = JSON.parse(a.config_json);
    assert.equal(snap.website.startUrl, 'https://xyz.com/');
    assert.ok(path.isAbsolute(snap.output.baseDir));
    config.crawler.maxPages = 999; // later changes never alter an existing job
    assert.equal(JSON.parse(store.getJob(a.id).config_json).crawler.maxPages, null);
    store.close();
  });

  test('transitions are compare-and-set and illegal ones throw', () => {
    const { store, make } = setup();
    const job = make();
    assert.throws(() => store.transition(job.id, [S.QUEUED], S.COMPLETED), StateError);
    assert.equal(store.transition(job.id, [S.QUEUED], S.STOPPED), true);
    assert.equal(store.transition(job.id, [S.QUEUED], S.STOPPED), false, 'second CAS from stale state fails');
    assert.equal(store.getJob(job.id).status, S.STOPPED);
    store.close();
  });

  test('only one worker can claim a job (duplicate worker prevention)', () => {
    const { store, make } = setup();
    const job = make();
    const token = dispatch(store, job.id, 'BACKGROUND');
    const claim = (dispatchToken, workerToken) => store.claimJob(job.id, {
      dispatchToken, workerToken, pid: process.pid, host: os.hostname(), processStartedAt: Date.now(), leaseMs: 60000,
    });
    assert.equal(claim('wrong-token', 'w0'), null, 'wrong dispatch token is refused');
    const first = claim(token, 'w1');
    assert.equal(first.status, S.STARTING);
    assert.equal(claim(token, 'w2'), null, 'dispatch token is single-use');
    assert.equal(store.heartbeat(job.id, 'w2', 60000), null, 'non-owner cannot heartbeat');
    assert.ok(store.heartbeat(job.id, 'w1', 60000));
    assert.equal(store.transition(job.id, [S.STARTING], S.RUNNING, {}, { expectToken: 'w2' }), false, 'non-owner cannot transition');
    store.close();
  });

  test('stale workers are detected and jobs marked INTERRUPTED', () => {
    const { store, make } = setup();
    const job = make();
    const token = dispatch(store, job.id, 'BACKGROUND');
    // A process that has already exited: its PID is no longer alive.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(dead.stdout);
    assert.equal(isPidAlive(deadPid), false);
    store.claimJob(job.id, { dispatchToken: token, workerToken: 'w', pid: deadPid, host: os.hostname(), processStartedAt: Date.now(), leaseMs: 60000 });
    store.transition(job.id, [S.STARTING], S.RUNNING, {}, { expectToken: 'w' });
    const pageId = store.insertPage({ job_id: job.id, url: 'https://xyz.com/', fetch_url: 'https://xyz.com/', depth: 0, status: 'QUEUED', source: 'start' });
    store.claimNextPage(job.id);
    assert.equal(store.getPage(pageId).status, 'PROCESSING');

    const recovered = recoverStaleJobs(store);
    assert.equal(recovered.length, 1);
    const after = store.getJob(job.id);
    assert.equal(after.status, S.INTERRUPTED);
    assert.match(after.status_reason, /not running/);
    assert.equal(store.getPage(pageId).status, 'QUEUED', 'in-flight work returns to the queue');
    store.close();
  });

  test('PID reuse by an unrelated process is not mistaken for the worker', () => {
    const job = { id: 'job_20260101_000000_deadbeef', mode: 'BACKGROUND', worker_pid: process.pid, worker_host: os.hostname(), worker_started_at: Date.now() };
    const v = verifyWorker(job); // this test process is alive but is not the worker
    assert.equal(v.state, 'mismatch');
  });

  test('foreground workers are identified by process start time', () => {
    const job = { id: 'job_20260101_000000_deadbeef', mode: 'FOREGROUND', worker_pid: process.pid, worker_host: os.hostname() };
    assert.equal(verifyWorker({ ...job, worker_started_at: currentProcessStartedAt() }).state, 'verified');
    assert.equal(verifyWorker({ ...job, worker_started_at: Date.now() - 86_400_000 }).state, 'mismatch', 'same PID, different start time');
    assert.equal(verifyWorker({ ...job, worker_host: 'another-machine' }).state, 'remote');
  });

  test('queued jobs whose worker never started are recovered', () => {
    const { store, make } = setup();
    const job = make();
    dispatch(store, job.id, 'BACKGROUND');
    store.updateJob(job.id, { dispatched_at: Date.now() - 120_000 });
    recoverStaleJobs(store);
    assert.equal(store.getJob(job.id).status, S.INTERRUPTED);
    store.close();
  });

  test('resume re-queues a stopped job; completed jobs cannot be resumed', async () => {
    const { store, make } = setup();
    const job = make();
    await stopJob(store, job.id);
    assert.equal(store.getJob(job.id).status, S.STOPPED);
    const failedId = store.insertPage({ job_id: job.id, url: 'https://xyz.com/x', fetch_url: 'https://xyz.com/x', depth: 1, status: 'FAILED', source: 'link' });
    const { job: resumed, token } = prepareResume(store, job.id, { mode: 'BACKGROUND', retryFailed: true });
    assert.equal(resumed.status, S.QUEUED);
    assert.equal(resumed.dispatch_token, token);
    assert.equal(store.getPage(failedId).status, 'QUEUED', '--retry-failed re-queues failed pages');
    assert.throws(() => prepareResume(store, job.id, { mode: 'BACKGROUND' }), UsageError, 'already queued');

    const done = make();
    store.db.prepare("UPDATE jobs SET status = 'COMPLETED' WHERE id = ?").run(done.id);
    assert.throws(() => prepareResume(store, done.id, { mode: 'BACKGROUND' }), /already COMPLETED/);
    store.close();
  });

  test('page queue is breadth-first and claim is atomic', () => {
    const { store, make } = setup();
    const job = make();
    store.insertPage({ job_id: job.id, url: 'b', fetch_url: 'b', depth: 2, status: 'QUEUED', source: 'link' });
    store.insertPage({ job_id: job.id, url: 'a', fetch_url: 'a', depth: 1, status: 'QUEUED', source: 'link' });
    assert.equal(store.insertPage({ job_id: job.id, url: 'a', fetch_url: 'a', depth: 1, status: 'QUEUED', source: 'link' }), null, 'deduplicated');
    store.insertPage({ job_id: job.id, url: 'later', fetch_url: 'later', depth: 0, status: 'QUEUED', source: 'link' });
    store.db.prepare('UPDATE pages SET next_attempt_at = ? WHERE url = ?').run(Date.now() + 60_000, 'later');
    assert.equal(store.claimNextPage(job.id).url, 'a');
    assert.equal(store.claimNextPage(job.id).url, 'b');
    assert.equal(store.claimNextPage(job.id), null, 'retry delay is respected');
    assert.equal(store.remainingWork(job.id).pages, 3);
    store.close();
  });
});
