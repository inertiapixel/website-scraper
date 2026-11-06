/**
 * Error types shared across the application. Each carries a stable `code`
 * so callers can branch on the kind of failure without string matching.
 */

export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Invalid user input on the command line. */
export class UsageError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'USAGE', ...opts });
  }
}

/** Invalid or contradictory configuration. `problems` lists every issue found. */
export class ConfigError extends AppError {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [String(problems)];
    super(`Invalid configuration:\n  - ${list.join('\n  - ')}`, { code: 'CONFIG' });
    this.problems = list;
  }
}

/** A request was refused before or during connection (SSRF protection, protocol, scope). */
export class BlockedRequestError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'BLOCKED', ...opts });
  }
}

/** A redirect pointed somewhere the current request is not allowed to go. */
export class RedirectScopeError extends AppError {
  constructor(message, { location, ...opts } = {}) {
    super(message, { code: 'REDIRECT_OUT_OF_SCOPE', ...opts });
    this.location = location;
  }
}

export class TooManyRedirectsError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'TOO_MANY_REDIRECTS', ...opts });
  }
}

/** The response body exceeded the configured size limit. */
export class SizeLimitError extends AppError {
  constructor(message, { limit, received, declared } = {}) {
    super(message, { code: 'SIZE_LIMIT' });
    this.limit = limit;
    this.received = received;
    this.declared = declared;
  }
}

/** The connection closed before the declared Content-Length was received. */
export class TruncatedResponseError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'TRUNCATED', ...opts });
  }
}

export class HttpStatusError extends AppError {
  constructor(status, url, { retryAfterMs } = {}) {
    super(`HTTP ${status}`, { code: 'HTTP_STATUS' });
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'TIMEOUT', ...opts });
  }
}

/** Work was cancelled because the job is stopping/pausing. Never counted as a failure. */
export class AbortedError extends AppError {
  constructor(message = 'Operation aborted', opts = {}) {
    super(message, { code: 'ABORTED', ...opts });
  }
}

/** A filter decided the resource must not be downloaded. Recorded as SKIPPED. */
export class SkipError extends AppError {
  constructor(reasonCode, message) {
    super(message, { code: 'SKIP' });
    this.reasonCode = reasonCode;
  }
}

/** Job state transition refused (e.g. concurrent change or invalid transition). */
export class StateError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'STATE', ...opts });
  }
}

export function isAbortError(err) {
  return err instanceof AbortedError || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
}

/** Network-level failures worth retrying (timeouts, resets, DNS hiccups, 5xx, 429, 408). */
export function isRetryable(err) {
  if (!err) return false;
  if (err instanceof HttpStatusError) {
    return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  }
  if (err instanceof TimeoutError || err instanceof TruncatedResponseError) return true;
  if (
    err instanceof SizeLimitError ||
    err instanceof BlockedRequestError ||
    err instanceof RedirectScopeError ||
    err instanceof TooManyRedirectsError ||
    err instanceof SkipError ||
    isAbortError(err)
  ) {
    return false;
  }
  const retryableCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH',
    'EHOSTUNREACH', 'ECONNABORTED', 'UND_ERR_SOCKET', 'ERR_STREAM_PREMATURE_CLOSE',
  ]);
  if (retryableCodes.has(err.code)) return true;
  // Playwright navigation errors are plain Errors with a descriptive message.
  if (/net::ERR_(CONNECTION|TIMED_OUT|NETWORK|EMPTY_RESPONSE|ABORTED)|Timeout \d+ms exceeded|Target page, context or browser has been closed|browser has disconnected|page crashed/i.test(err.message || '')) {
    return true;
  }
  return false;
}

/** Short, single-line description of an error suitable for reports and logs. */
export function describeError(err) {
  if (!err) return 'Unknown error';
  const msg = String(err.message || err).split('\n')[0].trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}
