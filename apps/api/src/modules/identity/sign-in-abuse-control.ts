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
 * ## Three keys, narrowest first, and a refusal stops there
 *
 * | key | shape | what it stops |
 * | --- | --- | --- |
 * | source+account | `sa:<ip>:<hash>` | one address grinding one account, ahead of the lockout |
 * | source | `s:<ip>` | one address spraying many accounts |
 * | global | `g` | a distributed spray from rotated addresses |
 *
 * They are consulted in that order — narrowest first — and the first key that refuses ends the
 * call. An **admitted** attempt charges all three. A **refused** attempt charges nothing wider
 * than the key that refused it.
 *
 * That asymmetry is the whole point, and getting it wrong was a defect the review of
 * 2026-09-07 found: charging the global budget on refused attempts let *one* address spend the
 * whole deployment's global budget at about two requests a second, after which nobody could
 * sign in for the rest of the window. Charging conditionally costs the global key nothing it
 * was built for — the distributed spray it exists to catch is by construction *admitted* by
 * every source key, and admitted attempts still charge it.
 *
 * The refusal names the narrowest key that is over budget, which is the one an operator
 * reading the event row needs to see. Because a refused attempt stops at that key, a wider key
 * can no longer cross its budget silently on an attempt reported under a narrower one, so its
 * one event row per window is never lost.
 *
 * Narrowest-first has one consequence an operator reading those rows will meet, so it is said
 * here rather than discovered: one address grinding a single account leaves no
 * `source_throttled` row, however long it grinds. Every attempt past the account budget stops
 * at `sa:` and charges nothing wider, so `s:` only ever sees the attempts the account budget
 * admitted and never reaches its own boundary — the grind is reported, but always as
 * `source_account_throttled`. The traffic the source row exists to report, one address across
 * many accounts, is unaffected: there the account keys admit and the source key is the one
 * that refuses and names itself.
 *
 * **D09 — proxy headers trusted unconditionally — is a separate, unfixed slice**, so anyone who
 * can reach the origin directly or set `X-Forwarded-For` can rotate the source key at will.
 * Both address-keyed budgets rotate with it: `sa:<ip>:<hash>` *contains* the address, so
 * rotating the header rotates the source key and the source+account key together. While D09
 * stands the only bounds that hold against a caller who can set that header are the global key
 * and the durable per-user lockout in `authentication_events` (`AUTH_MAX_FAILURES_IN_WINDOW`,
 * 5 failures in 900 s) — and the lockout is the one that actually catches a grind against a
 * named account. Read the two address-keyed budgets as a cost bound on honest traffic until
 * D09 lands, not as a defence against a determined attacker.
 *
 * One part of that weakness **outlives D09**, and the paragraph above would be read too kindly
 * without it. The source key is the address string as fastify hands it over, trimmed and
 * clamped and otherwise verbatim: there is no canonicalisation and no aggregation. So
 * `2001:DB8::1`, `2001:db8::1`, `::ffff:203.0.113.9` and `203.0.113.9` are four keys for what
 * may be one or two hosts, and — the part that matters — a caller on a single IPv6 /64 holds
 * 2^64 distinct source keys and can rotate through them for free even once proxy headers are
 * no longer trusted. Fixing D09 makes the source key *authentic*; it does not make it
 * *scarce*. The candidate fix is to canonicalise the address and key IPv6 at /64, which is
 * best done alongside D09 rather than before it, and it is recorded as a follow-up in
 * `docs/implementation-status.md` rather than left here as the only mention.
 *
 * ## Why the account arrives as a hash
 *
 * The map is long-lived process memory and has no business holding a list of the addresses
 * people typed, correct or guessed. SHA-256, truncated to 16 hex characters — it is a bucket,
 * not a credential, and it is computed here so no caller has to remember to do it.
 * Normalisation (`trim().toLowerCase()`) happens here too, matching `findUserIdByEmail`, so
 * `Ana@Example.test` and `ana@example.test ` cannot each buy their own budget.
 *
 * That normalisation is **narrower than the database's**, and the `sa:` key is therefore a
 * best-effort narrowing rather than a guarantee. `users.email` is `utf8mb4_unicode_ci`
 * (`migrations/0001_tenancy.sql`), which compares at primary weight — insensitive to case,
 * to accents and to compatibility variants — while this key hashes the bytes that survive
 * `trim().toLowerCase()`. So an accented or full-width variant of one real address resolves to
 * the *same* user in the lookup and lands in a *different* bucket here, and a caller grinding
 * one account can rotate the `sa:` key that way. What it costs is bounded and worth stating
 * plainly: the source key, the global key and the durable per-user lockout are all unaffected —
 * the lockout counts on the resolved `user_id`, which those variants share — so the practical
 * degradation is from the account budget to the source budget, ten attempts a window to thirty
 * at the defaults. Normalising harder (NFKD, strip combining marks) would narrow the gap;
 * closing it would mean keying on the resolved user id, which is the lookup this design exists
 * to run *after* the decision, not before it.
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
 * Memory is bounded in two directions, and it is worth saying which: in **key count**, because
 * at `maxKeys` the least recently seen window is dropped, and in **key length**, because the
 * source address is clamped to `MAX_SOURCE_KEY_LENGTH` before anything is keyed on it. The
 * length bound is not decoration — under D09 `request.ip` is the leftmost `X-Forwarded-For`
 * token verbatim, which fastify does not validate as an address, so without the clamp a caller
 * rotating kilobyte-long forged headers would grow these maps in bytes while staying inside
 * their bound in entries. An evicted key comes back with a fresh window: at worst that admits
 * a caller a little more than the budget says, never less. The same honesty applies to the
 * refusal flag below.
 *
 * The clock is the one place the error runs the other way. `createFixedWindowLimiter` tests a
 * window with `at - startedAt < windowMs`, which a *negative* delta also satisfies, so a clock
 * that jumps backwards by n ms holds a spent window open n ms longer and keeps a refused key
 * refused for that much longer. It fails closed, which is the right direction for a control
 * whose job is to refuse, and it is written here so nobody reads the eviction caveat above as
 * the only way these windows are inexact.
 *
 * ## Not a lockout — with one exception, and it is named
 *
 * The window self-heals. A shared office is refused for the remainder of one window and never
 * longer, and on the three `@Public()` routes no account is locked by another party's traffic
 * — those refusals are recorded with `user_id` NULL, so they name nobody and the durable
 * per-user counter cannot see them. Success is not exempt from the count, so a caller sitting
 * exactly at the boundary cannot keep guessing; that is why the per-source default is 30 rather
 * than 5.
 *
 * Reauthentication is the one place where a refusal *does* touch a user's failure count, and it
 * is deliberate rather than overlooked. The session guard has already established who is
 * calling, so the row names them (`confirmReauthentication`), and `countRecentFailures` filters
 * on user, outcome and window — not on action — so that row counts towards
 * `AUTH_MAX_FAILURES_IN_WINDOW` like any other failed row. Three things keep it honest: it can
 * only make the lockout stricter, never laxer; it is bounded at one row per key per window,
 * because only the attempt that first crosses the budget is recorded; and the only party who
 * can spend that budget is the holder of a live session for that same user.
 *
 * The **global key is the exception**, and pretending otherwise would be the dishonest version
 * of this paragraph: a global admission bound is a global refusal lever. Once its budget is
 * spent, every address and every account is refused until the window turns. Two things keep
 * that a considered trade rather than a hole.
 *
 * 1. **It is charged only by admitted attempts.** One address cannot reach it, because its own
 *    source key refuses it thirty attempts in; spending the global budget takes thousands of
 *    *admitted* attempts from distinct addresses.
 * 2. **It is sized as a CPU bound, not as an anomaly detector.**
 *    `RATE_LIMIT_AUTH_MAX_GLOBAL` defaults to 3000 per 300 s — about ten attempts a second,
 *    a fraction of what a single core can Argon2-verify — so it still stops a distributed
 *    spray from saturating the host, while a single attacker would have to sustain ten
 *    admitted attempts a second to deny anybody else.
 *
 * What is left is D09: while `main.ts` sets `trustProxy: true`, one attacker can look like
 * thousands of addresses, and every one of those attempts is admitted by its own source key.
 * That is the one route to the global refusal, and it is a reason to fix D09.
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

/**
 * How much of the source address reaches a key.
 *
 * 45 is the width of `authentication_events.ip` (`migrations/0004_credentials.sql`), so the
 * key and the row that records the refusal agree on what "the address" was. Any real IPv4 or
 * IPv6 address, including an IPv4-mapped one with a zone, fits well inside it; the values that
 * do not are forged `X-Forwarded-For` tokens, which is exactly what this bound exists for.
 */
const MAX_SOURCE_KEY_LENGTH = 45;

interface Charge {
  readonly admitted: boolean;
  readonly firstRefusalInWindow: boolean;
}

/**
 * One budget: the limiter, plus the memory of which keys are already refusing.
 *
 * `firstRefusalInWindow` is derived rather than asked of the limiter, and it is exact without
 * reaching inside it: every call that reaches this budget charges it, and the first call of a
 * window is always admitted (`max` is at least 1), so the calls that reach a key read
 * admitted…admitted, refused…refused, admitted — and clearing the mark on any admission is
 * precisely "the window turned". `admit` stops at the first refusal, so a wider budget simply
 * sees fewer calls; within the calls it does see, the sequence is unchanged.
 *
 * The mark set holds only keys currently refusing, and it is bounded the same way the limiter's
 * map is — *and in addition to it*, not instead of it: each budget carries a limiter map of at
 * most `maxKeys` entries plus a mark set of at most `maxKeys` more, so the worst case across the
 * three budgets is six times `maxKeys` entries, not three. An eviction costs one extra event row
 * for that key in that window, which is the same direction of error as the limiter's: a little
 * more, never less.
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
      const address =
        trimmed === undefined || trimmed === ''
          ? UNKNOWN_SOURCE
          : trimmed.slice(0, MAX_SOURCE_KEY_LENGTH);
      const bucket = account === undefined ? undefined : accountBucket(account);

      // Narrowest bound first, and stop at the first refusal. Two things follow, both of them
      // deliberate. The recorded reason names the tightest key that is over budget, which is
      // what an operator reading the event row needs. And a refused attempt charges nothing
      // wider than the key that refused it: without that, one address over its own source
      // budget would go on spending the deployment's global budget with attempts it is not
      // being served, which is a total sign-in outage bought at a couple of requests a second.
      // An admitted attempt still charges all three, so the distributed spray the global key
      // exists to catch — admitted by every source key, by construction — still spends it.
      if (bucket !== undefined) {
        const accountCharge = perSourceAccount(`sa:${address}:${bucket}`);
        if (!accountCharge.admitted) {
          return {
            admitted: false,
            reason: 'source_account_throttled',
            firstRefusalInWindow: accountCharge.firstRefusalInWindow,
          };
        }
      }

      const sourceCharge = perSource(`s:${address}`);
      if (!sourceCharge.admitted) {
        return {
          admitted: false,
          reason: 'source_throttled',
          firstRefusalInWindow: sourceCharge.firstRefusalInWindow,
        };
      }

      const globalCharge = globalBudget(GLOBAL_KEY);
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
