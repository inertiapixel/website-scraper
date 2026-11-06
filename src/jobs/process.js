/**
 * Worker process identity checks.
 *
 * A PID alone is not a safe identity: after a crash the PID may be reused by
 * an unrelated process. Before signalling a worker we verify that the PID is
 * alive, that its command line is our worker (or our CLI in foreground mode)
 * for this job, and that its start time matches the one the worker recorded.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const WORKER_MARKER = 'website-scraper-worker.js';
export const CLI_MARKER = 'website-scraper';

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Approximate wall-clock start time of the current process. */
export function currentProcessStartedAt() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

function parseEtime(etime) {
  // [[dd-]hh:]mm:ss
  const m = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

/** Command line and start time of a process, or null when unavailable. */
export function inspectProcess(pid) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { $p.CommandLine; ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }`,
      ], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim().split(/\r?\n/);
      if (out.length < 2) return null;
      return { command: out[0], startedAt: Number(out[1]) };
    }
    const out = execFileSync('ps', ['-o', 'etime=,command=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out) return null;
    const m = out.match(/^(\S+)\s+(.*)$/);
    if (!m) return null;
    const elapsed = parseEtime(m[1]);
    return { command: m[2], startedAt: elapsed == null ? null : Date.now() - elapsed * 1000 };
  } catch {
    return null;
  }
}

/**
 * @returns {{ state: 'none'|'dead'|'verified'|'mismatch'|'unverifiable'|'remote', detail: string }}
 */
export function verifyWorker(job) {
  if (!job.worker_pid) return { state: 'none', detail: 'no worker recorded' };
  if (job.worker_host && job.worker_host !== os.hostname()) {
    return { state: 'remote', detail: `worker runs on another host (${job.worker_host})` };
  }
  if (!isPidAlive(job.worker_pid)) return { state: 'dead', detail: `process ${job.worker_pid} is not running` };
  const info = inspectProcess(job.worker_pid);
  if (!info) return { state: 'unverifiable', detail: `process ${job.worker_pid} is alive but could not be inspected` };
  const startKnown = Boolean(job.worker_started_at) && info.startedAt != null;
  if (startKnown && Math.abs(info.startedAt - job.worker_started_at) > 5000) {
    return { state: 'mismatch', detail: `PID ${job.worker_pid} was reused by a newer process` };
  }
  const isWorker = info.command.includes(WORKER_MARKER) && info.command.includes(job.id);
  if (job.mode === 'BACKGROUND' && !isWorker) {
    return { state: 'mismatch', detail: `PID ${job.worker_pid} now belongs to an unrelated process` };
  }
  // Foreground jobs run inside the CLI process, whose command line depends on
  // how it was launched (npm script, global bin, ...): the start time decides.
  if (job.mode === 'FOREGROUND' && !startKnown && !info.command.includes(CLI_MARKER)) {
    return { state: 'mismatch', detail: `PID ${job.worker_pid} now belongs to an unrelated process` };
  }
  return { state: 'verified', detail: `process ${job.worker_pid}` };
}

/** Send a signal only after verifying the worker identity. */
export function signalWorker(job, signal) {
  const v = verifyWorker(job);
  if (v.state !== 'verified') return { sent: false, ...v };
  try {
    process.kill(job.worker_pid, signal);
    return { sent: true, ...v };
  } catch (err) {
    return { sent: false, state: 'dead', detail: err.message };
  }
}
