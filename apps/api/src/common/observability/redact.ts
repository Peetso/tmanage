/**
 * OBS-001. Field-level log redaction.
 *
 * `redactFields` is a pure function that walks a value and returns a structurally identical copy
 * with every sensitive field removed from view, so a log line, a trace attribute or an error
 * envelope can be serialized without leaking a credential or raw PII. It is the serializer hook
 * the app's structured logging routes through (see `serializeForLog` in `./logger.ts`).
 *
 * Three properties make it safe to call on arbitrary, untrusted-shape input:
 *
 * - **It matches keys, not values**, so a secret is caught wherever it sits — top level, nested,
 *   or inside an array of objects — rather than only where a caller remembered to redact.
 * - **Bounded depth.** A pathologically deep object is cut off at {@link REDACT_MAX_DEPTH} with a
 *   marker, so redaction cannot itself become an unbounded walk.
 * - **Circular-safe.** A cycle is replaced with `'[circular]'` and never throws; logging must not
 *   be the thing that crashes a request.
 */

/** The masked placeholder a denied field's value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * The deepest the walk descends before replacing further nesting with a marker. Comfortably
 * beyond any real log payload; its only job is to bound a hostile or accidentally recursive shape.
 */
export const REDACT_MAX_DEPTH = 8;

/**
 * Exact key names whose value is always removed, matched case-insensitively. The suffix rules
 * below (`*secret`, `*token`, `*password`) already cover the family names, so this set carries
 * only the keys those suffixes miss.
 */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'totp',
  'totpseed',
  'recoverycode',
  'authorization',
  'cookie',
  'set-cookie',
  // 52-12 (R22-a): the ZATCA certificate PUT body.
  'privatekeypem',
  'certificatepem',
]);

/** Case-insensitive suffixes: any key ending in one of these is a secret regardless of prefix. */
const DENIED_SUFFIXES: readonly string[] = ['secret', 'token', 'password'];

function isDeniedKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (DENIED_KEYS.has(lower)) return true;
  return DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Whether a key names an email address. Matches the `email` family the API actually logs —
 * `email` itself plus the `email*` / `*email` variants (`emailAddress`, `email_address`,
 * `userEmail`, `contactEmail`, `inviterEmail`) — case-insensitively. Deliberately NOT the
 * overloaded generic keys (`to`, `recipient`): in this codebase those carry state-machine
 * targets and user ids far more often than an address, and masking them would corrupt honest
 * logs. This stays a fixed family match, not a general PII classifier. The caller masks only
 * when the value is actually an address string, so sibling keys like `emailVerifiedAt` (a
 * timestamp) or `emailed` (a flag) pass through untouched.
 */
function isEmailKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('email') || lower.endsWith('email');
}

/**
 * Mask an email to its first character and domain — `john.doe@example.com` → `j***@example.com`.
 * The local part is what identifies a person; the domain is usually operationally useful and not
 * itself PII. Anything that is not a plausible address is redacted outright rather than guessed at.
 */
function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return REDACTED;
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return REDACTED;
  return `${value[0]}***${value.slice(at)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > REDACT_MAX_DEPTH) return '[max depth exceeded]';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const mapped = value.map((element) => redactValue(element, depth + 1, seen));
    // Unmark on exit: `seen` tracks only the current ancestor path, so a shared (non-cyclic)
    // reference reached again down a *different* branch is walked normally rather than being
    // mistaken for a cycle. A genuine back-edge to a still-open ancestor is still caught above.
    seen.delete(value);
    return mapped;
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isEmailKey(key) && typeof child === 'string' && child.includes('@')) {
        result[key] = maskEmail(child);
      } else if (isDeniedKey(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactValue(child, depth + 1, seen);
      }
    }
    // Unmark on exit — see the array branch above.
    seen.delete(value);
    return result;
  }

  // Primitives, functions, dates and other non-plain objects pass through unchanged: only a
  // sensitive *key* redacts a value, and a bare scalar has no key to judge it by.
  return value;
}

/**
 * Return a redacted copy of `input`. The input is never mutated. See the module doc for the
 * matching rules and the depth/cycle bounds.
 */
export function redactFields(input: unknown): unknown {
  return redactValue(input, 0, new WeakSet<object>());
}
