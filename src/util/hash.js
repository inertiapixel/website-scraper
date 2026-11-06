import { createHash } from 'node:crypto';

/** Deterministic short hex hash used for collision-resistant file names. */
export function shortHash(value, length = 8) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}
