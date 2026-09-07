import { createHash } from 'node:crypto';
import {
  createFixedWindowLimiter,
  FIXED_WINDOW_DEFAULT_MAX_KEYS,
} from '../../common/http/rate-limiter.js';

/**
 * Source-based abuse control for the public authentication routes — the production review of
 * 2026-09-07 (**D08**).
 *
 * The lockout that exists counts failures *per user* (`AUTH_MAX_FAILURES_IN_WINDOW`,
 * `countRecentFailures`), which is the right control for one account under attack and no
 * control at all for the attack this finding names: one address trying one password against
 * ten thousand addresses it guessed. Every one of those attempts is a fresh user, so every
 * one of them passes the per-user counter, burns an Argon2 verify (deliberately, even for an
 * unknown email, to keep the timing flat) and writes an `authentication_events` row. Nothing
 * bounded either cost by *where the traffic came from*. This module is that bound, and it is
 * consulted before the read, before Argon2, and before the row.
 *
 * ## Three keys, all charged, the narrowest one refuses
 *
 * | key | shape | what it stops |
 * | --- | --- | --- |
 * | source | `s:<ip>` | one address spraying many accounts |
 * | source+account | `sa:<ip>:<hash>` | one address grinding one account, ahead of the lockout |
 * | global | `g` | a distributed spray from rotated addresses |
 *
 * All three are charged on every call, so a caller cannot spend a cheap key to keep an
 * expensive one idle; the refusal then names the **narrowest** key that is over budget, which
 * is the one an operator reading the event row needs to see.
 *
 * The global key is not belt-and-braces. **D09 — proxy headers trusted unconditionally — is a
 * separate, unfixed slice**, so anyone who can reach the origin directly or set
 * `X-Forwarded-For` can rotate the source key at will. Do not read the source key as sound
 * while that stands: the account key is not evadable that way, and the global key is not
 * evadable at all.
 *
 * ## Why the account arrives as a hash
 *
 * The map is long-lived process memory and has no business holding a list of the addresses
 * people typed, correct or guessed. SHA-256, truncated to 16 hex characters — it is a bucket,
 * not a credential, and it is computed here so no caller has to remember to do it.
 * Normalisation (`trim().toLowerCase()`) happens here too, matching `findUserIdByEmail`, so
 * `Ana@Example.test` and `ana@example.test ` cannot each buy their own budget.
 *
 * ## What in-process costs
 *
 * The store is `createFixedWindowLimiter`, in process, legitimate for the reason that file
 * already gives: the bootstrap profile runs one API process (`50-BOOTSTRAP` §3, `main.ts`).
 * The two consequences are repeated here rather than assumed: **a restart forgets every
 * window, and a second process would count separately.** The database is deliberately not
 * used — a row per attempt is the log exhaustion this finding is about, and the durable
 * per-user lockout already covers the case that must survive a restart.
 *
 * Memory is bounded by construction. At `maxKeys` the least recently seen window is dropped,
 * so an evicted key comes back with a fresh window: at worst that admits a caller a little
 * more than the budget says, never less. The same honesty applies to the refusal flag below.
 *
 * ## Not a lockout
 *
 * The window self-heals. A shared office is refused for the remainder of one window and never
 * longer, and no account is ever locked by another party's traffic — the source keys refuse
 * *requests from that source*, they do not touch the user's failure count. Success is not
 * exempt from the count, so a caller sitting exactly at the boundary cannot keep guessing;
 * that is why the per-source default is 30 rather than 5.
 */

export interface SignInAbuseOptions {
  readonly windowMs: number;
  /** Attempts admitted per address per window, across every account it names. */
  readonly maxPerSource: number;
  /** Attempts admitted per address *and* account per window. */
  readonly maxPerSourceAccount: number;
  /** Attempts admitted across every address per window. */
  readonly maxGlobal: number;
  /** Distinct keys remembered per budget; the oldest window goes first. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

/** Which bound fired, in the words `authentication_events.reason` records. */
export type SignInAbuseReason =
  'source_throttled' | 'source_account_throttled' | 'global_throttled';

export type SignInAbuseVerdict =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: SignInAbuseReason;
      /**
       * True only on the attempt that first crossed this key's budget in this window. It is
       * what keeps the trace the migration asks for ("a burst of them from one source is
       * enumeration, and it is the only trace of it") without re-creating the flood: one row
       * per key per window — plus one per eviction from the refusing-key set, the caveat
       * `createBudget` states below — rather than one per refused attempt.
       */
      readonly firstRefusalInWindow: boolean;
    };

export interface SignInAbuseControl {
  admit(input: { ip: string | null | undefined; account?: string | undefined }): SignInAbuseVerdict;
}

/** The bucket a request with no usable address falls into — one key, not one per caller. */
const UNKNOWN_SOURCE = 'unknown';

/** The global key. A constant, because every attempt shares it. */
const GLOBAL_KEY = 'g';

interface Charge {
  readonly admitted: boolean;
  readonly firstRefusalInWindow: boolean;
}

/**
 * One budget: the limiter, plus the memory of which keys are already refusing.
 *
 * `firstRefusalInWindow` is derived rather than asked of the limiter, and it is exact without
 * reaching inside it: every key is charged on every call, the first call of a window is always
 * admitted (`max` is at least 1), so a key's calls read admitted…admitted, refused…refused,
 * admitted — and clearing the mark on any admission is precisely "the window turned".
 *
 * The mark set holds only keys currently refusing, and is bounded like the limiter's own map.
 * An eviction costs one extra event row for that key in that window, which is the same
 * direction of error as the limiter's: a little more, never less.
 */
const createBudget = (options: {
  readonly windowMs: number;
  readonly max: number;
  readonly maxKeys: number;
  readonly now: () => number;
}): ((key: string) => Charge) => {
  const admit = createFixedWindowLimiter(options);
  // Insertion order is first-refusal order, and it is FIFO rather than the limiter's LRU: a
  // key's position here is never refreshed by a later refusal, so the first entry is the key
  // that started refusing longest ago.
  const refusing = new Set<string>();

  return (key) => {
    if (admit(key)) {
      refusing.delete(key);
      return { admitted: true, firstRefusalInWindow: false };
    }
    if (refusing.has(key)) return { admitted: false, firstRefusalInWindow: false };
    if (refusing.size >= options.maxKeys) {
      const oldest = refusing.values().next().value;
      if (oldest !== undefined) refusing.delete(oldest);
    }
    refusing.add(key);
    return { admitted: false, firstRefusalInWindow: true };
  };
};

/**
 * The account, normalised the way `findUserIdByEmail` normalises it, then hashed.
 *
 * Returns `undefined` for an account that is empty once trimmed: there is nothing to key on,
 * and a shared empty bucket would let one caller's blank input crowd out another's.
 */
const accountBucket = (account: string): string | undefined => {
  const normalised = account.trim().toLowerCase();
  if (normalised === '') return undefined;
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
};

export function createSignInAbuseControl(options: SignInAbuseOptions): SignInAbuseControl {
  const shared = {
    windowMs: options.windowMs,
    maxKeys: Math.max(1, options.maxKeys ?? FIXED_WINDOW_DEFAULT_MAX_KEYS),
    now: options.now ?? Date.now,
  };
  const perSource = createBudget({ ...shared, max: options.maxPerSource });
  const perSourceAccount = createBudget({ ...shared, max: options.maxPerSourceAccount });
  // One key, so one window; `maxKeys` is irrelevant to it and left at the shared value.
  const globalBudget = createBudget({ ...shared, max: options.maxGlobal });

  return {
    admit({ ip, account }) {
      const trimmed = ip?.trim();
      const address = trimmed === undefined || trimmed === '' ? UNKNOWN_SOURCE : trimmed;
      const bucket = account === undefined ? undefined : accountBucket(account);

      // Charge every applicable key before deciding: a refusal by one budget must not leave
      // the others unpaid, or an attacker would ride the cheapest refusal for free.
      const sourceCharge = perSource(`s:${address}`);
      const accountCharge =
        bucket === undefined ? undefined : perSourceAccount(`sa:${address}:${bucket}`);
      const globalCharge = globalBudget(GLOBAL_KEY);

      // Narrowest bound first, so the recorded reason names the tightest one that fired.
      if (accountCharge !== undefined && !accountCharge.admitted) {
        return {
          admitted: false,
          reason: 'source_account_throttled',
          firstRefusalInWindow: accountCharge.firstRefusalInWindow,
        };
      }
      if (!sourceCharge.admitted) {
        return {
          admitted: false,
          reason: 'source_throttled',
          firstRefusalInWindow: sourceCharge.firstRefusalInWindow,
        };
      }
      if (!globalCharge.admitted) {
        return {
          admitted: false,
          reason: 'global_throttled',
          firstRefusalInWindow: globalCharge.firstRefusalInWindow,
        };
      }
      return { admitted: true };
    },
  };
}
