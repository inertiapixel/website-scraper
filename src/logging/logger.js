/**
 * Per-job, timestamped logger. Every line passes through `redactSecrets`, so
 * credentials, tokens, cookies and authorization values never reach a log.
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS = [
  // key=value pairs in URLs or text
  [/\b((?:access_|refresh_|id_)?token|api[_-]?key|apikey|secret|password|passwd|pwd|session(?:id)?|sid|sig|signature|auth|code|credential|jwt|x-amz-[a-z-]+|x-goog-[a-z-]+)=([^&\s"'<>]+)/gi, '$1=[REDACTED]'],
  // header-style values
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\n]+/gi, '$1: [REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED]'],
  // credentials embedded in URLs
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
];

export function redactSecrets(text) {
  let out = String(text);
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export class Logger {
  /**
   * @param {object} opts
   * @param {string} [opts.filePath] append log lines to this file
   * @param {boolean} [opts.console] also print to the terminal
   * @param {NodeJS.WritableStream} [opts.stream] write lines to this stream (background worker stdout)
   * @param {string} [opts.level]
   */
  constructor({ filePath = null, console: toConsole = false, stream = null, level = 'info' } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.toConsole = toConsole;
    this.stream = stream;
    this.fd = null;
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.fd = fs.openSync(filePath, 'a');
    }
  }

  #write(level, args) {
    if (LEVELS[level] < this.level) return;
    const msg = redactSecrets(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, line);
      } catch {
        /* disk full or closed: never crash because of logging */
      }
    }
    if (this.stream) this.stream.write(line);
    if (this.toConsole) {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      out.write(level === 'info' ? `${msg}\n` : `[${level.toUpperCase()}] ${msg}\n`);
    }
  }

  debug(...a) { this.#write('debug', a); }
  info(...a) { this.#write('info', a); }
  warn(...a) { this.#write('warn', a); }
  error(...a) { this.#write('error', a); }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, close() {} };
