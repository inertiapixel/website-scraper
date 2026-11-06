/**
 * Job lifecycle.
 *
 *   QUEUED ──► STARTING ──► RUNNING ──► COMPLETED
 *     │           │           ├──► PAUSING ──► PAUSED ──► (resume) QUEUED
 *     │           │           ├──► STOPPING ─► STOPPED ─► (resume) QUEUED
 *     │           │           ├──► FAILED ──────────────► (resume) QUEUED
 *     └───────────┴───────────┴──► INTERRUPTED ─────────► (resume) QUEUED
 *
 * Every transition is applied with a compare-and-set UPDATE, so concurrent
 * processes (CLI + worker) can never apply conflicting transitions.
 */
export const JobStatus = Object.freeze({
  QUEUED: 'QUEUED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  PAUSING: 'PAUSING',
  PAUSED: 'PAUSED',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  INTERRUPTED: 'INTERRUPTED',
});

const S = JobStatus;

export const TRANSITIONS = Object.freeze({
  [S.QUEUED]: [S.STARTING, S.STOPPED, S.FAILED, S.INTERRUPTED],
  [S.STARTING]: [S.RUNNING, S.PAUSING, S.STOPPING, S.FAILED, S.INTERRUPTED],
  [S.RUNNING]: [S.PAUSING, S.STOPPING, S.COMPLETED, S.FAILED, S.INTERRUPTED],
  [S.PAUSING]: [S.PAUSED, S.STOPPING, S.FAILED, S.INTERRUPTED],
  [S.STOPPING]: [S.STOPPED, S.FAILED, S.INTERRUPTED],
  [S.PAUSED]: [S.QUEUED, S.STOPPED],
  [S.STOPPED]: [S.QUEUED],
  [S.FAILED]: [S.QUEUED],
  [S.INTERRUPTED]: [S.QUEUED, S.STOPPED],
  [S.COMPLETED]: [],
});

/** Statuses in which a worker process is expected to be alive. */
export const ACTIVE_STATUSES = Object.freeze([S.STARTING, S.RUNNING, S.PAUSING, S.STOPPING]);
export const RESUMABLE_STATUSES = Object.freeze([S.PAUSED, S.STOPPED, S.INTERRUPTED, S.FAILED]);
export const FINAL_STATUSES = Object.freeze([S.COMPLETED, S.STOPPED, S.FAILED, S.PAUSED, S.INTERRUPTED]);

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** All statuses that may legally transition into `to`. */
export function predecessorsOf(to) {
  return Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));
}

export const PageStatus = Object.freeze({
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

export const AssetStatus = Object.freeze({
  PENDING: 'PENDING',
  DOWNLOADING: 'DOWNLOADING',
  DOWNLOADED: 'DOWNLOADED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
});
