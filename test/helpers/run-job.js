import path from 'node:path';
import { loadConfig, deepMerge } from '../../src/config/load.js';
import { JobStore } from '../../src/jobs/store.js';
import { createJob, dispatch } from '../../src/jobs/service.js';
import { runWorker } from '../../src/jobs/worker.js';
import { tempDir } from './fixtures.js';

/** Fast, local-only settings for tests. */
export const TEST_OVERRIDES = {
  crawler: {
    renderer: 'http',
    requestDelayMs: 0,
    retries: 1,
    retryBackoffMs: 50,
    navigationTimeoutMs: 15000,
    settle: { waitUntil: 'load', networkQuietMs: 100, networkQuietTimeoutMs: 1500, delayMs: 0, waitForSelector: null },
    lazyLoad: { enabled: true, maxScrolls: 5, scrollDelayMs: 50, promoteDataAttributes: true },
  },
  download: { requestDelayMs: 0, retries: 1, retryBackoffMs: 50, timeoutMs: 10000 },
  network: { allowPrivateNetworks: true },
  logging: { level: 'debug' },
};

export function testConfig(startUrl, overrides = {}, outputBase = tempDir('ws-out-')) {
  const merged = deepMerge(deepMerge(TEST_OVERRIDES, { website: { startUrl }, output: { baseDir: outputBase } }), overrides);
  return loadConfig({ overrides: merged, requireStartUrl: true });
}

/** Create a job and run it to completion in this process. */
export async function runTestJob({ startUrl, overrides = {}, resolveOverride = null, deps = {}, home = tempDir('ws-home-') }) {
  const config = testConfig(startUrl, overrides);
  const store = JobStore.open(home);
  const job = createJob(store, { config, mode: 'FOREGROUND', home });
  const token = dispatch(store, job.id, 'FOREGROUND');
  store.close();
  const result = await runWorker({
    home, jobId: job.id, dispatchToken: token, mode: 'FOREGROUND', handleSignals: false, consoleOutput: false,
    deps: { resolveOverride, ...deps },
  });
  const after = JobStore.open(home);
  return {
    home,
    job: after.getJob(job.id),
    result,
    store: after,
    out: (rel) => path.join(job.output_dir, rel),
    page: (url) => after.findPage(job.id, url),
    asset: (url) => after.findAsset(job.id, url),
  };
}
