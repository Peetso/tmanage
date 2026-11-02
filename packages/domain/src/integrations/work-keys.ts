/**
 * 54-10 GitHub, Phase 0 (R16-e) — work keys (`TM-482`).
 *
 * A project's prefix is Latin `[A-Z0-9]`, 2..10 characters, starting with a letter, so a key is
 * safe in a git branch name (`feature/TM-12-hero`) and unique per organization. Keys stay Latin
 * for an Arabic project too: git refs and commit trailers are where they are typed.
 *
 * Pure: no I/O, no clock.
 */

/** At most this many distinct keys are taken from one text (a monorepo push flood). */
export const MAX_WORK_KEYS_PER_TEXT = 10;

const PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/u;
/** A key not glued to a letter or digit on either side; the number has 1..9 digits. */
const KEY_PATTERN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-([0-9]{1,9})(?![0-9])/gu;

export interface WorkKey {
  readonly prefix: string;
  readonly number: number;
}

/** Whether `value` is a valid, already upper-cased prefix. */
export function isWorkKeyPrefix(value: unknown): value is string {
  return typeof value === 'string' && PREFIX_PATTERN.test(value);
}

/** Trim and upper-case a typed prefix; null when it is not a valid one. */
export function normalizeWorkKeyPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return isWorkKeyPrefix(upper) ? upper : null;
}

export function formatWorkKey(prefix: string, number: number): string {
  return `${prefix}-${String(number)}`;
}

/**
 * The distinct keys in `text` whose prefix is one of `prefixes` (case-insensitive: `tm-12` is
 * `TM-12`), in order of first appearance, at most {@link MAX_WORK_KEYS_PER_TEXT}. Number 0 and
 * unknown prefixes are ignored.
 */
export function parseWorkKeys(text: string, prefixes: Iterable<string>): WorkKey[] {
  const known = new Set([...prefixes].map((prefix) => prefix.toUpperCase()));
  const seen = new Set<string>();
  const keys: WorkKey[] = [];
  if (known.size === 0 || typeof text !== 'string') return keys;
  for (const match of text.matchAll(KEY_PATTERN)) {
    const prefix = (match[1] ?? '').toUpperCase();
    const number = Number(match[2]);
    if (!known.has(prefix) || number < 1) continue;
    const key = formatWorkKey(prefix, number);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ prefix, number });
    if (keys.length >= MAX_WORK_KEYS_PER_TEXT) break;
  }
  return keys;
}
