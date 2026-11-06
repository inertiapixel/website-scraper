#!/usr/bin/env node
/**
 * Background worker entry point (started by `scrape --background` and
 * `job:resume`). Not intended to be run by hand: it only runs a job when it
 * holds the job's one-time dispatch token.
 */
import { parseArgs } from 'node:util';
import { runWorker } from '../src/jobs/worker.js';
import { resolveHome } from '../src/jobs/service.js';

const { values } = parseArgs({ options: { job: { type: 'string' } }, strict: true });
const token = process.env.WEBSITE_SCRAPER_DISPATCH_TOKEN;
delete process.env.WEBSITE_SCRAPER_DISPATCH_TOKEN;

if (!values.job || !token) {
  process.stderr.write('website-scraper-worker: --job and a dispatch token are required (start jobs with "npm run scrape:background")\n');
  process.exit(2);
}

const result = await runWorker({ home: resolveHome(), jobId: values.job, dispatchToken: token, mode: 'BACKGROUND' });
process.exit(result.exitCode);
