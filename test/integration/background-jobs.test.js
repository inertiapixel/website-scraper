/**
 * End-to-end tests of job-based execution through the real CLI and detached
 * background worker processes.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer, siteHandler, html, tempDir } from '../helpers/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'website-scraper.js');
const WORKER = path.join(ROOT, 'bin', 'website-scraper-worker.js');
const PAGES = 24;
const PAGE_DELAY_MS = 200;

let server;
let home;
let overlay;
let outDir;

/**
 * Run a command asynchronously. (spawnSync would block this process, and with
 * it the fixture web server the worker is talking to.)
 */
function run(file, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: ROOT, env: { ...process.env, WEBSITE_SCRAPER_HOME: home, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, out: `${stdout}${stderr}` }));
  });
}

const cli = (args, env) => run(CLI, args, env);

async function status(id) {
  const r = await cli(['status', id, '--json']);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.stdout);
}

async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 200, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function startBackground(extra = []) {
  const t0 = Date.now();
  const r = await cli(['scrape', server.url('/'), '--background', '--config', overlay, ...extra]);
  const elapsed = Date.now() - t0;
  assert.equal(r.code, 0, r.out);
  const id = r.stdout.match(/Job ID: (job_\d{8}_\d{6}_[0-9a-f]{8})/)?.[1];
  assert.ok(id, r.out);
  return { id, elapsed, output: r.stdout };
}

function baseOverlay() {
  return {
    crawler: { renderer: 'http', concurrency: 1, requestDelayMs: 0, retries: 0, sitemap: { enabled: false } },
    download: { requestDelayMs: 0 },
    network: { allowPrivateNetworks: true },
    output: { baseDir: outDir },
  };
}

before(async () => {
  const routes = {
    '/': { body: html(Array.from({ length: PAGES }, (_, i) => `<a href="/p/${i}">page ${i}</a>`).join('') + '<img src="/logo.png">') },
    '/logo.png': { type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) },
    '/forbidden/': { status: 403, body: 'Forbidden' },
  };
  for (let i = 0; i < PAGES; i++) routes[`/p/${i}`] = { delay: PAGE_DELAY_MS, body: html(`<h1>Page ${i}</h1><a href="/">home</a>`) };
  server = await startServer(siteHandler(routes));
  home = tempDir('ws-bg-home-');
  outDir = tempDir('ws-bg-out-');
  overlay = path.join(home, 'test-config.json');
  fs.writeFileSync(overlay, JSON.stringify(baseOverlay()));
});

after(async () => {
  // Make sure no worker outlives the tests.
  const db = new Database(path.join(home, 'jobs.db'), { readonly: true });
  for (const row of db.prepare("SELECT worker_pid FROM jobs WHERE status IN ('STARTING','RUNNING','PAUSING','STOPPING')").all()) {
    try {
      process.kill(row.worker_pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  db.close();
  await server.close();
});

describe('background jobs', () => {
  let job;

  test('scrape:background creates a persistent job and returns promptly', async () => {
    job = await startBackground();
    assert.ok(job.elapsed < 10_000, `CLI took ${job.elapsed} ms`);
    assert.match(job.output, /Background job created successfully/);
    assert.match(job.output, /Mode: BACKGROUND/);
    assert.match(job.output, new RegExp(`Output: .*127\\.0\\.0\\.1_${server.port}/${job.id}/`));
    assert.match(job.output, new RegExp(`npm run job:status -- ${job.id}`));
    assert.match(job.output, new RegExp(`npm run job:logs -- ${job.id}`));
  });

  test('the worker keeps running after the CLI exited and reports progress', async () => {
    const snap = await waitFor(async () => {
      const s = await status(job.id);
      return s.status === 'RUNNING' && s.pages.completed >= 3 ? s : null;
    }, { what: 'progress' });
    assert.match(snap.worker.health, /^healthy \(pid \d+/);
    assert.ok(snap.pages.discovered >= PAGES);
    assert.ok(snap.pages.queued > 0);
    assert.ok(snap.activity);

    const text = (await cli(['status', job.id])).stdout;
    for (const label of ['Job ID:', 'Website:', 'Status:', 'Worker:', 'Created:', 'Started:', 'Elapsed:', 'Pages', 'Assets', 'Output:']) {
      assert.ok(text.includes(label), label);
    }
  });

  test('a second worker for the same job is refused', async () => {
    const r = await run(WORKER, ['--job', job.id], { WEBSITE_SCRAPER_DISPATCH_TOKEN: 'forged-token' });
    assert.equal(r.code, 3, r.out);
    assert.match(r.out, /Only one worker may run a job at a time/);
    const resume = await cli(['resume', job.id]);
    assert.equal(resume.code, 2);
    assert.match(resume.stderr, /RUNNING/);
    assert.equal((await status(job.id)).status, 'RUNNING', 'the original worker is unaffected');
  });

  test('jobs and logs commands', async () => {
    const list = await cli(['jobs']);
    assert.equal(list.code, 0);
    assert.match(list.stdout, new RegExp(`${job.id}\\s+RUNNING`));
    const logs = await cli(['logs', job.id, '--lines', '50']);
    assert.equal(logs.code, 0);
    assert.match(logs.stdout, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO\] Worker started: pid \d+/m);
    assert.match(logs.stdout, /\[INFO\] Page 1: /);
  });

  let completedAtStop;
  test('a job stops gracefully without corrupting state', async () => {
    const t0 = Date.now();
    const r = await cli(['stop', job.id]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Status: STOPPED/);
    assert.ok(Date.now() - t0 < 10_000, 'in-flight work finished well within the grace period');
    const snap = await status(job.id);
    assert.equal(snap.status, 'STOPPED');
    assert.equal(snap.pages.processing, 0, 'no page left in PROCESSING');
    assert.ok(snap.pages.queued > 0, 'remaining work is still queued');
    completedAtStop = snap.pages.completed;
    assert.ok(completedAtStop >= 3 && completedAtStop < PAGES + 1);

    const db = new Database(path.join(home, 'jobs.db'), { readonly: true });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    db.close();
    const report = JSON.parse(fs.readFileSync(path.join(snap.outputDir, 'crawl-report.json'), 'utf8'));
    assert.equal(report.partial, true);
    assert.ok(fs.existsSync(path.join(snap.outputDir, 'index.html')), 'partial output is written on stop');
  });

  test('a stopped job resumes from its persisted queue without refetching completed pages', async () => {
    const r = await cli(['resume', job.id]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, new RegExp(`${completedAtStop} page\\(s\\) .*already captured`));
    const snap = await waitFor(async () => {
      const s = await status(job.id);
      return ['COMPLETED', 'FAILED'].includes(s.status) ? s : null;
    }, { what: 'completion' });
    assert.equal(snap.status, 'COMPLETED', snap.lastError);
    assert.equal(snap.pages.completed, PAGES + 1);
    assert.equal(snap.runs, 2);
    for (let i = 0; i < PAGES; i++) assert.equal(server.hitCount(`127.0.0.1/p/${i}`), 1, `/p/${i} fetched exactly once`);
    assert.equal(server.hitCount('127.0.0.1/'), 1);
    for (let i = 0; i < PAGES; i++) assert.ok(fs.existsSync(path.join(snap.outputDir, 'p', String(i), 'index.html')));
    const follow = await cli(['logs', job.id, '--follow']);
    assert.match(follow.stdout, /-- job COMPLETED --/);
    const log = fs.readFileSync(snap.logPath, 'utf8');
    assert.doesNotMatch(log, /no longer holds the job lease/, 'finishing must not look like a lost lease');
    assert.doesNotMatch(log, /\[ERROR\]/);
  });

  test('a killed worker is detected as stale and the job can be resumed', async () => {
    for (const k of [...server.hits.keys()]) server.hits.delete(k);
    const j = await startBackground();
    const running = await waitFor(async () => {
      const s = await status(j.id);
      return s.status === 'RUNNING' && s.pages.completed >= 2 ? s : null;
    }, { what: 'running job' });
    process.kill(running.worker.pid, 'SIGKILL');
    await waitFor(() => {
      try {
        process.kill(running.worker.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { what: 'worker exit' });

    const list = await cli(['jobs']);
    assert.match(list.stdout, new RegExp(`${j.id}\\s+INTERRUPTED`));
    const snap = await status(j.id);
    assert.match(snap.statusReason, /Worker stopped unexpectedly: process \d+ is not running/);
    assert.equal(snap.pages.processing, 0);

    // The job keeps its configuration snapshot even if the config file changes.
    fs.writeFileSync(overlay, JSON.stringify({ crawler: { maxPages: 1 }, network: { allowPrivateNetworks: true }, output: { baseDir: outDir } }));
    assert.equal((await cli(['resume', j.id])).code, 0);
    const done = await waitFor(async () => {
      const s = await status(j.id);
      return ['COMPLETED', 'FAILED'].includes(s.status) ? s : null;
    }, { what: 'completion after resume' });
    assert.equal(done.status, 'COMPLETED', done.lastError);
    assert.equal(done.pages.completed, PAGES + 1, 'original snapshot (no maxPages) still applies');
  });

  test('a background job that fails right away reports the failure immediately', async () => {
    fs.writeFileSync(overlay, JSON.stringify(baseOverlay())); // undo the previous test's edit
    const r = await cli(['scrape', server.url('/forbidden/'), '--background', '--config', overlay]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.stdout, /finished immediately/);
    assert.match(r.stdout, /job FAILED \(No pages were captured: the starting page failed \(HTTP 403\)\)/);
    assert.doesNotMatch(r.stdout, /Status: RUNNING/);
  });

  test('--follow streams progress and prints the final result', async () => {
    const r = await cli(['scrape', server.url('/'), '--background', '--follow', '--config', overlay]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.stdout, /Background job created successfully/);
    assert.match(r.stdout, /Following progress/);
    assert.match(r.stdout, /\[INFO\] Page 1: /);
    assert.match(r.stdout, /-- job COMPLETED --/);
    assert.match(r.stdout, /Website Scraper: job COMPLETED/);
    assert.match(r.stdout, new RegExp(`Pages:  ${PAGES + 1} saved, 0 failed`));
  });

  test('help and validation errors', async () => {
    const help = await cli(['help']);
    assert.equal(help.code, 0);
    for (const c of ['scrape', 'scrape:background', 'jobs', 'job:status', 'job:logs', 'job:stop', 'job:resume']) assert.ok(help.stdout.includes(c), c);
    assert.match((await cli(['scrape', 'not a url'])).stderr, /must start with http/);
    assert.match((await cli(['scrape', 'https://example.com', '--max-depth', 'x'])).stderr, /--max-depth must be a whole number/);
    assert.match((await cli(['status', 'nope'])).stderr, /not a valid job ID/);
    assert.match((await cli(['status', 'job_20200101_000000_00000000'])).stderr, /not found/);
    assert.match((await cli(['frobnicate'])).stderr, /Unknown command/);
    const badConfig = path.join(home, 'bad.json');
    fs.writeFileSync(badConfig, JSON.stringify({ crawler: { concurency: 3 } }));
    assert.match((await cli(['scrape', 'https://example.com', '--config', badConfig])).stderr, /Did you mean "crawler.concurrency"/);
  });
});
