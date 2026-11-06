import { sleep } from '../util/time.js';

/**
 * Per-host minimum interval between request starts. Slots are reserved
 * synchronously, so concurrent callers for the same host are serialized.
 */
export class HostRateLimiter {
  constructor(defaultIntervalMs) {
    this.defaultIntervalMs = defaultIntervalMs;
    this.next = new Map();
    this.intervals = new Map();
  }

  /** Raise the interval for one host (e.g. robots.txt Crawl-delay). Never lowers it. */
  setMinInterval(host, ms) {
    const current = this.intervals.get(host) ?? this.defaultIntervalMs;
    if (ms > current) this.intervals.set(host, ms);
  }

  /** Push the next slot for a host into the future (e.g. after HTTP 429 Retry-After). */
  penalize(host, ms) {
    const at = Date.now() + ms;
    if ((this.next.get(host) ?? 0) < at) this.next.set(host, at);
  }

  async wait(host, signal) {
    const interval = this.intervals.get(host) ?? this.defaultIntervalMs;
    const now = Date.now();
    const slot = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, slot + interval);
    if (this.next.size > 10_000) this.#prune(now);
    await sleep(slot - now, signal);
  }

  #prune(now) {
    for (const [host, at] of this.next) if (at < now) this.next.delete(host);
  }
}
