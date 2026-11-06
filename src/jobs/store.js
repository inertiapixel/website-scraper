/**
 * Durable job state in SQLite (better-sqlite3, WAL mode).
 *
 * SQLite gives atomic multi-row transactions and safe concurrent access from
 * the CLI and worker processes. All queue state lives here: jobs, the page
 * frontier (with depth/attempts/next retry time), asset download state,
 * redirect aliases and the local-path registry, so a crashed or stopped job
 * can resume exactly where it left off.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { JobStatus, PageStatus, AssetStatus, canTransition } from './states.js';
import { StateError } from '../util/errors.js';
import { pathKey, alternatePath, collisionPath } from '../output/paths.js';

const SCHEMA_VERSION = 2;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  start_url TEXT NOT NULL,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_json TEXT NOT NULL,
  output_dir TEXT NOT NULL,
  job_dir TEXT NOT NULL,
  log_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  run_started_at INTEGER,
  completed_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  dispatch_token TEXT,
  dispatched_at INTEGER,
  worker_token TEXT,
  worker_pid INTEGER,
  worker_host TEXT,
  worker_started_at INTEGER,
  heartbeat_at INTEGER,
  lease_expires_at INTEGER,
  phase TEXT,
  seeded INTEGER NOT NULL DEFAULT 0,
  current_activity TEXT,
  last_error TEXT,
  status_reason TEXT,
  unrecorded_urls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  fetch_url TEXT NOT NULL,
  path_key TEXT,
  pattern TEXT,
  depth INTEGER NOT NULL,
  external INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  parent_url TEXT,
  final_url TEXT,
  http_status INTEGER,
  content_type TEXT,
  local_path TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  reason TEXT,
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, url)
);
CREATE INDEX IF NOT EXISTS pages_queue ON pages(job_id, status, depth, id);
CREATE INDEX IF NOT EXISTS pages_path_key ON pages(job_id, path_key);
CREATE INDEX IF NOT EXISTS pages_pattern ON pages(job_id, pattern);

CREATE TABLE IF NOT EXISTS page_aliases (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  PRIMARY KEY (job_id, url)
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  final_url TEXT,
  status TEXT NOT NULL,
  hint TEXT,
  category TEXT,
  mime TEXT,
  size INTEGER,
  local_path TEXT,
  css_depth INTEGER NOT NULL DEFAULT 0,
  referrer TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  reason TEXT,
  staged INTEGER NOT NULL DEFAULT 0,
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, url)
);
CREATE INDEX IF NOT EXISTS assets_queue ON assets(job_id, status, id);
CREATE INDEX IF NOT EXISTS assets_final ON assets(job_id, final_url);

CREATE TABLE IF NOT EXISTS local_paths (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  path_key TEXT NOT NULL,
  path TEXT NOT NULL,
  owner TEXT NOT NULL,
  PRIMARY KEY (job_id, path_key)
);
CREATE INDEX IF NOT EXISTS local_paths_owner ON local_paths(job_id, owner);
`;

const JOB_COLUMNS = new Set([
  'status', 'mode', 'updated_at', 'started_at', 'run_started_at', 'completed_at', 'run_count', 'dispatch_token',
  'dispatched_at', 'worker_token', 'worker_pid', 'worker_host', 'worker_started_at', 'heartbeat_at',
  'lease_expires_at', 'phase', 'seeded', 'current_activity', 'last_error', 'status_reason', 'unrecorded_urls', 'notify_tty',
]);
const PAGE_COLUMNS = new Set([
  'status', 'final_url', 'http_status', 'content_type', 'local_path', 'attempts', 'next_attempt_at',
  'reason_code', 'reason', 'updated_at', 'depth', 'external', 'source', 'parent_url',
]);
const ASSET_COLUMNS = new Set([
  'status', 'final_url', 'category', 'mime', 'size', 'local_path', 'attempts', 'next_attempt_at',
  'reason_code', 'reason', 'staged', 'updated_at',
]);

function setClause(fields, allowed) {
  const keys = Object.keys(fields);
  for (const k of keys) if (!allowed.has(k)) throw new Error(`Unknown column "${k}"`);
  return { sql: keys.map((k) => `${k} = @${k}`).join(', '), keys };
}

export class JobStore {
  /** Open (and migrate) the store in `homeDir`. */
  static open(homeDir) {
    fs.mkdirSync(homeDir, { recursive: true });
    return new JobStore(path.join(homeDir, 'jobs.db'));
  }

  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 15000');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.#migrate();
    this.stmts = new Map();
  }

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version > SCHEMA_VERSION) {
      throw new Error(`Job database ${this.dbPath} was created by a newer version (schema ${version})`);
    }
    if (version < 1) this.db.exec(MIGRATION_1);
    if (version < 2) {
      // Terminal that should receive the end-of-job notice (background jobs).
      this.db.exec('ALTER TABLE jobs ADD COLUMN notify_tty TEXT');
    }
    if (version < SCHEMA_VERSION) this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  #stmt(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  close() {
    if (this.db.open) this.db.close();
  }

  /** Run `fn` in an IMMEDIATE transaction (takes the write lock up front). */
  tx(fn) {
    return this.db.transaction(fn).immediate();
  }

  // ---- jobs -------------------------------------------------------------

  createJob(job) {
    const now = Date.now();
    this.#stmt(`
      INSERT INTO jobs (id, start_url, hostname, status, mode, config_json, output_dir, job_dir, log_path, created_at, updated_at)
      VALUES (@id, @start_url, @hostname, @status, @mode, @config_json, @output_dir, @job_dir, @log_path, @created_at, @updated_at)
    `).run({ status: JobStatus.QUEUED, created_at: now, updated_at: now, ...job });
    return this.getJob(job.id);
  }

  getJob(id) {
    return this.#stmt('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  listJobs({ limit = 50, status = null } = {}) {
    if (status) return this.#stmt('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    return this.#stmt('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  jobsWithStatus(statuses) {
    const placeholders = statuses.map(() => '?').join(', ');
    return this.#stmt(`SELECT * FROM jobs WHERE status IN (${placeholders})`).all(...statuses);
  }

  /**
   * Compare-and-set status transition. `from` lists acceptable current
   * statuses (each must be a legal predecessor of `to`). Optional
   * `expectToken` requires the caller to hold the worker lease.
   * @returns {boolean} whether the transition was applied
   */
  transition(id, from, to, fields = {}, { expectToken } = {}) {
    for (const f of from) if (!canTransition(f, to)) throw new StateError(`Illegal transition ${f} -> ${to}`);
    const { sql, keys } = setClause({ ...fields, status: to, updated_at: Date.now() }, JOB_COLUMNS);
    const params = { id, ...fields, status: to, updated_at: Date.now() };
    for (const k of keys) if (params[k] === undefined) params[k] = null;
    const fromList = from.map((_s, i) => `@from${i}`).join(', ');
    from.forEach((s, i) => { params[`from${i}`] = s; });
    let where = `id = @id AND status IN (${fromList})`;
    if (expectToken !== undefined) {
      where += ' AND worker_token = @expect_token';
      params.expect_token = expectToken;
    }
    return this.#stmt(`UPDATE jobs SET ${sql} WHERE ${where}`).run(params).changes === 1;
  }

  updateJob(id, fields, { expectToken } = {}) {
    const { sql } = setClause({ ...fields, updated_at: Date.now() }, JOB_COLUMNS);
    const params = { id, ...fields, updated_at: Date.now() };
    let where = 'id = @id';
    if (expectToken !== undefined) {
      where += ' AND worker_token = @expect_token';
      params.expect_token = expectToken;
    }
    return this.#stmt(`UPDATE jobs SET ${sql} WHERE ${where}`).run(params).changes === 1;
  }

  /**
   * Atomically take ownership of a QUEUED job. Only the process holding the
   * matching dispatch token can claim it, which prevents duplicate workers
   * and PID-file style startup races.
   */
  claimJob(id, { dispatchToken, workerToken, pid, host, processStartedAt, leaseMs }) {
    const now = Date.now();
    const res = this.#stmt(`
      UPDATE jobs SET
        status = 'STARTING', worker_token = @workerToken, worker_pid = @pid, worker_host = @host,
        worker_started_at = @processStartedAt, heartbeat_at = @now, lease_expires_at = @lease,
        run_started_at = @now, started_at = COALESCE(started_at, @now), run_count = run_count + 1,
        dispatch_token = NULL, updated_at = @now, current_activity = 'Starting worker', status_reason = NULL
      WHERE id = @id AND status = 'QUEUED' AND dispatch_token = @dispatchToken
    `).run({ id, dispatchToken, workerToken, pid, host, processStartedAt, now, lease: now + leaseMs });
    return res.changes === 1 ? this.getJob(id) : null;
  }

  /**
   * Ask the worker to print its result on `tty` when the job ends. Applied
   * only while the job is still unfinished; returns false if it has already
   * ended (the caller should then print the result itself).
   */
  setNotifyTtyIfUnfinished(id, tty) {
    return this.#stmt(`UPDATE jobs SET notify_tty = ? WHERE id = ?
      AND status NOT IN ('COMPLETED', 'STOPPED', 'FAILED', 'PAUSED', 'INTERRUPTED')`).run(tty, id).changes === 1;
  }

  /** Extend the lease. Returns the current job row, or null if the lease was lost. */
  heartbeat(id, token, leaseMs) {
    const now = Date.now();
    const res = this.#stmt('UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ? AND worker_token = ?')
      .run(now, now + leaseMs, id, token);
    return res.changes === 1 ? this.getJob(id) : null;
  }

  // ---- pages ------------------------------------------------------------

  findPage(jobId, url) {
    return this.#stmt('SELECT * FROM pages WHERE job_id = ? AND url = ?').get(jobId, url) ?? null;
  }

  getPage(id) {
    return this.#stmt('SELECT * FROM pages WHERE id = ?').get(id) ?? null;
  }

  findAlias(jobId, url) {
    return this.#stmt('SELECT page_id FROM page_aliases WHERE job_id = ? AND url = ?').get(jobId, url)?.page_id ?? null;
  }

  addAlias(jobId, url, pageId) {
    this.#stmt('INSERT OR IGNORE INTO page_aliases (job_id, url, page_id) VALUES (?, ?, ?)').run(jobId, url, pageId);
  }

  insertPage(row) {
    const now = Date.now();
    const res = this.#stmt(`
      INSERT OR IGNORE INTO pages (job_id, url, fetch_url, path_key, pattern, depth, external, status, source,
        parent_url, reason_code, reason, discovered_at, updated_at)
      VALUES (@job_id, @url, @fetch_url, @path_key, @pattern, @depth, @external, @status, @source,
        @parent_url, @reason_code, @reason, @now, @now)
    `).run({ path_key: null, pattern: null, external: 0, parent_url: null, reason_code: null, reason: null, ...row, now });
    return res.changes === 1 ? Number(res.lastInsertRowid) : null;
  }

  updatePage(id, fields) {
    const { sql } = setClause({ ...fields, updated_at: Date.now() }, PAGE_COLUMNS);
    this.#stmt(`UPDATE pages SET ${sql} WHERE id = @id`).run({ id, ...fields, updated_at: Date.now() });
  }

  /** Claim the next due page (breadth-first by depth). */
  claimNextPage(jobId) {
    const now = Date.now();
    return this.tx(() => {
      const row = this.#stmt(`
        SELECT id FROM pages WHERE job_id = ? AND status = 'QUEUED' AND next_attempt_at <= ?
        ORDER BY depth, id LIMIT 1
      `).get(jobId, now);
      if (!row) return null;
      this.#stmt("UPDATE pages SET status = 'PROCESSING', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      return this.getPage(row.id);
    });
  }

  /** Earliest retry time among queued pages that are not yet due, or null. */
  nextPageDueAt(jobId) {
    return this.#stmt("SELECT MIN(next_attempt_at) AS t FROM pages WHERE job_id = ? AND status = 'QUEUED'").get(jobId)?.t ?? null;
  }

  countPagesWhere(jobId, column, value) {
    if (column !== 'path_key' && column !== 'pattern') throw new Error('invalid column');
    return this.#stmt(`SELECT COUNT(*) AS n FROM pages WHERE job_id = ? AND ${column} = ? AND status != 'SKIPPED'`).get(jobId, value).n;
  }

  countAcceptedPages(jobId) {
    return this.#stmt("SELECT COUNT(*) AS n FROM pages WHERE job_id = ? AND status != 'SKIPPED'").get(jobId).n;
  }

  countRecordedUrls(jobId) {
    const p = this.#stmt('SELECT COUNT(*) AS n FROM pages WHERE job_id = ?').get(jobId).n;
    const a = this.#stmt('SELECT COUNT(*) AS n FROM assets WHERE job_id = ?').get(jobId).n;
    return p + a;
  }

  pageCounts(jobId) {
    const counts = { discovered: 0, queued: 0, processing: 0, completed: 0, failed: 0, skipped: 0 };
    for (const r of this.#stmt('SELECT status, COUNT(*) AS n FROM pages WHERE job_id = ? GROUP BY status').all(jobId)) {
      counts.discovered += r.n;
      counts[r.status.toLowerCase()] = r.n;
    }
    return counts;
  }

  processingPages(jobId, limit = 10) {
    return this.#stmt("SELECT url, fetch_url FROM pages WHERE job_id = ? AND status = 'PROCESSING' LIMIT ?").all(jobId, limit);
  }

  iteratePages(jobId, status = null) {
    if (status) return this.#stmt('SELECT * FROM pages WHERE job_id = ? AND status = ? ORDER BY id').iterate(jobId, status);
    return this.#stmt('SELECT * FROM pages WHERE job_id = ? ORDER BY id').iterate(jobId);
  }

  pageIdsWithStatus(jobId, status) {
    return this.#stmt('SELECT id FROM pages WHERE job_id = ? AND status = ? ORDER BY id').all(jobId, status).map((r) => r.id);
  }

  /** Completed page whose URL or alias matches the normalized key. */
  resolveCompletedPage(jobId, key) {
    const direct = this.#stmt("SELECT local_path FROM pages WHERE job_id = ? AND url = ? AND status = 'COMPLETED'").get(jobId, key);
    if (direct) return direct.local_path;
    const alias = this.#stmt(`
      SELECT p.local_path FROM page_aliases a JOIN pages p ON p.id = a.page_id
      WHERE a.job_id = ? AND a.url = ? AND p.status = 'COMPLETED'
    `).get(jobId, key);
    return alias?.local_path ?? null;
  }

  // ---- assets -----------------------------------------------------------

  findAsset(jobId, url) {
    return this.#stmt('SELECT * FROM assets WHERE job_id = ? AND url = ?').get(jobId, url) ?? null;
  }

  findAssetByFinalUrl(jobId, url) {
    return this.#stmt("SELECT * FROM assets WHERE job_id = ? AND final_url = ? AND status = 'DOWNLOADED' LIMIT 1").get(jobId, url) ?? null;
  }

  getAsset(id) {
    return this.#stmt('SELECT * FROM assets WHERE id = ?').get(id) ?? null;
  }

  insertAsset(row) {
    const now = Date.now();
    const res = this.#stmt(`
      INSERT OR IGNORE INTO assets (job_id, url, status, hint, css_depth, referrer, reason_code, reason, discovered_at, updated_at)
      VALUES (@job_id, @url, @status, @hint, @css_depth, @referrer, @reason_code, @reason, @now, @now)
    `).run({ hint: null, css_depth: 0, referrer: null, reason_code: null, reason: null, ...row, now });
    return res.changes === 1 ? Number(res.lastInsertRowid) : null;
  }

  updateAsset(id, fields) {
    const { sql } = setClause({ ...fields, updated_at: Date.now() }, ASSET_COLUMNS);
    this.#stmt(`UPDATE assets SET ${sql} WHERE id = @id`).run({ id, ...fields, updated_at: Date.now() });
  }

  claimNextAsset(jobId) {
    const now = Date.now();
    return this.tx(() => {
      const row = this.#stmt(`
        SELECT id FROM assets WHERE job_id = ? AND status = 'PENDING' AND next_attempt_at <= ? ORDER BY id LIMIT 1
      `).get(jobId, now);
      if (!row) return null;
      this.#stmt("UPDATE assets SET status = 'DOWNLOADING', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, row.id);
      return this.getAsset(row.id);
    });
  }

  nextAssetDueAt(jobId) {
    return this.#stmt("SELECT MIN(next_attempt_at) AS t FROM assets WHERE job_id = ? AND status = 'PENDING'").get(jobId)?.t ?? null;
  }

  assetCounts(jobId) {
    const counts = { discovered: 0, pending: 0, downloading: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
    for (const r of this.#stmt('SELECT status, COUNT(*) AS n, SUM(size) AS bytes FROM assets WHERE job_id = ? GROUP BY status').all(jobId)) {
      counts.discovered += r.n;
      counts[r.status.toLowerCase()] = r.n;
      if (r.status === AssetStatus.DOWNLOADED) counts.bytes = r.bytes || 0;
    }
    return counts;
  }

  iterateAssets(jobId, status = null) {
    if (status) return this.#stmt('SELECT * FROM assets WHERE job_id = ? AND status = ? ORDER BY id').iterate(jobId, status);
    return this.#stmt('SELECT * FROM assets WHERE job_id = ? ORDER BY id').iterate(jobId);
  }

  stagedStylesheetIds(jobId) {
    return this.#stmt("SELECT id FROM assets WHERE job_id = ? AND status = 'DOWNLOADED' AND staged = 1 ORDER BY id").all(jobId).map((r) => r.id);
  }

  /** Local path of a downloaded asset by original or final URL. */
  resolveDownloadedAsset(jobId, url) {
    const row = this.#stmt(`
      SELECT local_path FROM assets WHERE job_id = ? AND status = 'DOWNLOADED' AND (url = ? OR final_url = ?) LIMIT 1
    `).get(jobId, url, url);
    return row?.local_path ?? null;
  }

  // ---- reporting helpers ------------------------------------------------

  /** Keyset-paginated rows (never holds a statement open across awaits). */
  pagesBatch(jobId, afterId, limit = 500) {
    return this.#stmt('SELECT * FROM pages WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?').all(jobId, afterId, limit);
  }

  assetsBatch(jobId, afterId, limit = 500) {
    return this.#stmt('SELECT * FROM assets WHERE job_id = ? AND id > ? ORDER BY id LIMIT ?').all(jobId, afterId, limit);
  }

  startPage(jobId) {
    return this.#stmt("SELECT * FROM pages WHERE job_id = ? AND source = 'start' ORDER BY id LIMIT 1").get(jobId) ?? null;
  }

  topReasons(jobId, table, status, limit = 5) {
    if (table !== 'pages' && table !== 'assets') throw new Error('invalid table');
    return this.#stmt(`
      SELECT reason_code, MIN(reason) AS example, COUNT(*) AS n FROM ${table}
      WHERE job_id = ? AND status = ? GROUP BY reason_code ORDER BY n DESC LIMIT ?
    `).all(jobId, status, limit);
  }

  // ---- recovery ---------------------------------------------------------

  /** Return in-flight work to the queue after a stop/crash. */
  resetInFlight(jobId) {
    return this.tx(() => {
      const p = this.#stmt("UPDATE pages SET status = 'QUEUED', updated_at = ? WHERE job_id = ? AND status = 'PROCESSING'").run(Date.now(), jobId).changes;
      const a = this.#stmt("UPDATE assets SET status = 'PENDING', updated_at = ? WHERE job_id = ? AND status = 'DOWNLOADING'").run(Date.now(), jobId).changes;
      return { pages: p, assets: a };
    });
  }

  /** Re-queue failed items (resume --retry-failed). Attempts are reset. */
  requeueFailed(jobId) {
    return this.tx(() => {
      const now = Date.now();
      const p = this.#stmt(`UPDATE pages SET status = 'QUEUED', attempts = 0, next_attempt_at = 0, reason_code = NULL, reason = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'FAILED'`).run(now, jobId).changes;
      const a = this.#stmt(`UPDATE assets SET status = 'PENDING', attempts = 0, next_attempt_at = 0, reason_code = NULL, reason = NULL, updated_at = ?
        WHERE job_id = ? AND status = 'FAILED'`).run(now, jobId).changes;
      return { pages: p, assets: a };
    });
  }

  remainingWork(jobId) {
    const p = this.#stmt("SELECT COUNT(*) AS n FROM pages WHERE job_id = ? AND status IN ('QUEUED', 'PROCESSING')").get(jobId).n;
    const a = this.#stmt("SELECT COUNT(*) AS n FROM assets WHERE job_id = ? AND status IN ('PENDING', 'DOWNLOADING')").get(jobId).n;
    return { pages: p, assets: a, total: p + a };
  }

  // ---- local path registry ------------------------------------------------

  #pathConflicts(jobId, rel, owner) {
    const key = pathKey(rel);
    const same = this.#stmt('SELECT owner FROM local_paths WHERE job_id = ? AND path_key = ?').get(jobId, key);
    if (same) return same.owner !== owner;
    // A reserved file may not be an ancestor directory of this path...
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/');
      if (this.#stmt('SELECT 1 FROM local_paths WHERE job_id = ? AND path_key = ?').get(jobId, ancestor)) return true;
    }
    // ...and this path may not be the directory of an existing file.
    const below = this.#stmt('SELECT 1 FROM local_paths WHERE job_id = ? AND path_key >= ? AND path_key < ? LIMIT 1')
      .get(jobId, `${key}/`, `${key}0`);
    return Boolean(below);
  }

  /**
   * Reserve a unique local path for `owner` (e.g. "page:12"). Tries the
   * preferred path, then a hashed variant, then a collision-directory path.
   * Idempotent: the same owner always gets back its existing reservation.
   */
  reservePath(jobId, owner, preferred) {
    return this.tx(() => {
      const existing = this.#stmt('SELECT path FROM local_paths WHERE job_id = ? AND owner = ?').get(jobId, owner);
      if (existing) return existing.path;
      for (const candidate of [preferred, alternatePath(preferred, owner), collisionPath(preferred, owner)]) {
        if (!this.#pathConflicts(jobId, candidate, owner)) {
          this.#stmt('INSERT INTO local_paths (job_id, path_key, path, owner) VALUES (?, ?, ?, ?)')
            .run(jobId, pathKey(candidate), candidate, owner);
          return candidate;
        }
      }
      throw new Error(`Could not reserve a local path for ${owner}`);
    });
  }

  reservedPathOf(jobId, owner) {
    return this.#stmt('SELECT path FROM local_paths WHERE job_id = ? AND owner = ?').get(jobId, owner)?.path ?? null;
  }
}

export { JobStatus, PageStatus, AssetStatus };
