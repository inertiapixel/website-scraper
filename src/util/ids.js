import { randomBytes, randomUUID } from 'node:crypto';

/** Sortable, human-readable, unique job id: job_YYYYMMDD_HHMMSS_<8 hex>. */
export function createJobId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}_` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `job_${stamp}_${randomBytes(4).toString('hex')}`;
}

export function createToken() {
  return randomUUID();
}

export const JOB_ID_PATTERN = /^job_\d{8}_\d{6}_[0-9a-f]{8}$/;
