import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Logger, redactSecrets } from '../../src/logging/logger.js';
import { tempDir } from '../helpers/fixtures.js';

test('secrets never reach log output', () => {
  const samples = [
    'GET https://x.com/a?access_token=abc123&page=1',
    'Authorization: Bearer eyJhbGciOi.payload.sig',
    'cookie: session=deadbeef; other=1',
    'https://admin:hunter2@x.com/',
    'api_key=K-123 password=pw signature=SIG',
  ];
  const out = samples.map(redactSecrets).join('\n');
  for (const secret of ['abc123', 'eyJhbGciOi', 'deadbeef', 'hunter2', 'K-123', '=pw', 'SIG']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('page=1'));
});

test('log lines are timestamped and written to the job log file', () => {
  const file = path.join(tempDir(), 'job.log');
  const log = new Logger({ filePath: file, level: 'info' });
  log.debug('hidden');
  log.info('visible token=xyz');
  log.close();
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] visible token=\[REDACTED\]\n$/);
});
