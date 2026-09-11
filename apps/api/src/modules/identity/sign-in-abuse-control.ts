import { createHash } from 'node:crypto';
import {
  createTwoPhaseFixedWindowLimiter,
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
 * ## Three keys, narrowest first, and a refusal charges nothing but the key that refused
 *
 * | key | shape | what it stops |
 * | --- | --- | --- |
 * | source+account | `sa:<ip>:<hash>` | one address grinding one account, ahead of the lockout |
 * | source | `s:<ip>` | one address spraying many accounts |
 * | global | `g` | a distributed spray from rotated addresses |
 *
 * The decision is **two-phase**. Every applicable budget is *asked* first, narrowest key first
 * and stopping at the first refusal, and nothing is mutated by the asking. Only when all of
 * them admit is any *other* one charged. So an **admitted** attempt charges all three, and a
 * **refused** attempt charges nothing but the key that refused it — nothing wider, and nothing
 * narrower.
 *
 * Both halves of that were defects, found one review apart, and both were the same mistake:
 * an attempt that was never served still spent somebody's budget.
 *
 * - *Wider.* Charging the global budget on refused attempts let **one** address spend the whole
 *   deployment's global budget at about two requests a second, after which nobody could sign in
 *   for the rest of the window (final review of 2026-09-07, C-1).
 * - *Narrower.* Charging `sa:` before `s:` had been consulted let a person behind a shared
 *   address burn their own account budget on attempts the *source* budget refused — so their
 *   `sa:` window started late, ran on past the end of the source window that had actually
 *   refused them, and left them throttled longer than the control's own window (re-review of
 *   2026-09-07, N-1). Two-phase charging is what makes the self-healing sentence below true
 *   rather than nearly true.
 *
 * Charging conditionally costs the global key nothing it was built for — the distributed spray
 * it exists to catch is by construction *admitted* by every source key, and admitted attempts
 * still charge it. It costs the narrower keys nothing either: the attempts they no longer see
 * are attempts nobody was served.
 *
 * The refusal names the narrowest key that is over budget, which is the one an operator
 * reading the event row needs to see. Because a refused attempt charges only that key, a wider
 * key can no longer cross its budget silently on an attempt reported under a narrower one, so
 * its one event row per window is never lost. The refusing key itself *is* charged, which
 * changes no verdict — it is already over budget for the rest of the window — and is what keeps
 * `firstRefusalInWindow` and the limiter's own recency ordering reading exactly as they did.
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
 * **D09 is fixed** (branch `d09-trusted-proxy`). `main.ts` no longer passes
 * `trustProxy: true`; trust comes from `TRUSTED_PROXY_ADDRESSES`
 * (`packages/config/src/trusted-proxies.ts`), parsed and validated at boot, and **unset or
 * blank means trust nobody**. `request.ip` is then the socket peer and `X-Forwarded-For` is an
 * ordinary header that changes nothing, so a caller reaching the origin directly can no longer
 * rotate the source key by writing one.
 *
 * What survives that fix is narrower, and saying so here is the point of this paragraph. Where
 * the operator *has* named a proxy, `request.ip` is the last forwarded entry that is not itself
 * trusted, taken **verbatim** and never validated as an address. So a caller behind a trusted
 * proxy that *appends* to `X-Forwarded-For` rather than replacing it still chooses the value,
 * and both address-keyed budgets rotate together for them: `sa:<ip>:<hash>` *contains* the
 * address. Against such a caller the bounds that hold are the global key and the durable
 * per-user lockout in `authentication_events` (`AUTH_MAX_FAILURES_IN_WINDOW`, 5 failures in
 * 900 s) — and the lockout is the one that actually catches a grind against a named account.
 * The remedy is deployment-side and is written down for the operator in
 * `docs/runbooks/deploy.md`: the proxy must overwrite the header, not add to it.
 *
 * One part of that weakness **outlives D09**, and the paragraphs above would be read too kindly
 * without it. The source key is the address string as fastify hands it over, trimmed and
 * clamped and otherwise verbatim: there is no canonicalisation and no aggregation. So
 * `2001:DB8::1`, `2001:db8::1`, `::ffff:203.0.113.9` and `203.0.113.9` are four keys for what
 * may be one or two hosts, and — the part that matters — a caller on a single IPv6 /64 holds
 * 2^64 distinct source keys and can rotate through them for free now that proxy headers are no
 * longer believed. D09 made the source key *authentic*; it did not make it *scarce*. The
 * candidate fix is to canonicalise the address and key IPv6 at /64. It is **still open**, and
 * it is recorded as follow-up 6 in `docs/implementation-status.md` rather than left here as
 * the only mention.
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
 * The store is `createTwoPhaseFixedWindowLimiter` (`rate-limiter.ts`, which now expresses
 * `createFixedWindowLimiter` in terms of it), in process, legitimate for the reason that file
 * already gives: the bootstrap profile runs one API process (`50-BOOTSTRAP` §3, `main.ts`).
 * The two consequences are repeated here rather than assumed: **a restart forgets every
 * window, and a second process would count separately.** The database is deliberately not
 * used — a row per attempt is the log exhaustion this finding is about, and the durable
 * per-user lockout already covers the case that must survive a restart.
 *
 * Memory is bounded in two directions, and it is worth saying which: in **key count**, because
 * at `maxKeys` the least recently seen window is dropped, and in **key length**, because the
 * source address is clamped to `MAX_SOURCE_KEY_LENGTH` before anything is keyed on it. The
 * length bound is not decoration — wherever a proxy is trusted, `request.ip` is a forwarded
 * token taken verbatim, which nothing on the way here validates as an address, so without the
 * clamp a caller behind an appending proxy rotating kilobyte-long values would grow these maps
 * in bytes while staying inside their bound in entries. An evicted key comes back with a fresh
 * window: at worst that admits a caller a little more than the budget says, never less. The
 * same honesty applies to the refusal flag below.
 *
 * The clock is the one place the error runs the other way. The limiter tests a
 * window with `at - startedAt < windowMs`, which a *negative* delta also satisfies, so a clock
 * that jumps backwards by n ms holds a spent window open n ms longer and keeps a refused key
 * refused for that much longer. It fails closed, which is the right direction for a control
 * whose job is to refuse, and it is written here so nobody reads the eviction caveat above as
 * the only way these windows are inexact.
 *
 * ## Not a lockout — with one exception, and it is named
 *
 * The window self-heals. A shared office is refused for the remainder of one window and never
 * longer — and that sentence is load-bearing enough to say what makes it true, because it was
 * false until the two-phase charge above landed. A refused attempt charges only the key that
 * refused it, so the wait a caller serves is the wait of the key that named them and of no
 * other: the attempts the source key refuses do not start, extend or spend that caller's own
 * `sa:` window, and cannot leave them throttled past the moment the source window turns.
 *
 * On the three `@Public()` routes no account is locked by another party's traffic — those
 * refusals are recorded with `user_id` NULL, so they name nobody and the durable per-user
 * counter cannot see them. Success is not exempt from the count, so a caller sitting exactly at
 * the boundary cannot keep guessing; that is why the per-source default is 30 rather than 5.
 *
 * Reauthentication is the one route whose refusal row *names* a user, and it is deliberate
 * rather than overlooked: the session guard has already established who is calling, so the row
 * names them (`confirmReauthentication`) and an operator reading it beside the `locked_out` row
 * does not have to guess. What that row does **not** do is move them towards the durable
 * lockout. `countRecentFailures` (`credentials.repository.ts`) excludes the three
 * {@link SIGN_IN_ABUSE_REASONS} from its count, because a throttle refusal is not a credential
 * failure — nobody guessed anything, and the attempt never reached a password.
 *
 * That exclusion is a fix, not a decoration. Before it, a refusal under the `s:` or `g:` key —
 * budgets *everybody* spends — wrote a `failed` row bearing the session holder's user id and
 * counted towards `AUTH_MAX_FAILURES_IN_WINDOW` exactly as a wrong password did, so unrelated
 * traffic from the same office — or, wherever the address can be chosen, from anywhere — could
 * drive a named user into their own 900-second lockout. The re-review of 2026-09-07 found it
 * as N-2. The audit trail is
 * unchanged — the row is still written, still names the user, still carries the reason — and
 * only the counter stopped reading it.
 *
 * The **global key is the exception**, and pretending otherwise would be the dishonest version
 * of this paragraph: a global admission bound is a global refusal lever. Once its budget is
 * spent, every address and every account is refused until the window turns. Two things keep
 * that a considered trade rather than a hole.
 *
 * 1. **It is only ever *crossed* by admitted attempts.** Not "charged only by" them: when `g`
 *    is the key that refuses, `admit()` charges it like any refusing key (see the charging
 *    paragraph above), and that charge lands on a budget already past its limit, so it moves
 *    no verdict. What a refused attempt never does is charge a budget it did not reach. One
 *    address therefore cannot take `g` over its limit: its own source key refuses it thirty
 *    attempts in, and those refusals charge `s:` and nothing wider. Crossing the global budget
 *    takes thousands of *admitted* attempts from distinct addresses.
 * 2. **It is sized as a CPU bound, not as an anomaly detector.**
 *    `RATE_LIMIT_AUTH_MAX_GLOBAL` defaults to 3000 per 300 s — about ten attempts a second,
 *    a fraction of what a single core can Argon2-verify — so it still stops a distributed
 *    spray from saturating the host, while a single attacker would have to sustain ten
 *    admitted attempts a second to deny anybody else.
 *
 * What is left is deployment-shaped rather than code-shaped, and D09 is what made it so. One
 * attacker can still look like thousands of addresses — from behind a trusted proxy that
 * appends to `X-Forwarded-For` instead of replacing it, or across an IPv6 /64 they genuinely
 * hold (follow-up 6) — and every one of those attempts is admitted by its own source key. That
 * is the one route to the global refusal. A caller with no trusted proxy in front of them no
 * longer has it: their address is the socket peer, and their own source key refuses them
 * thirty attempts in. Configuring the proxy to overwrite the header
 * (`docs/runbooks/deploy.md`) closes the first half; nothing here closes the second.
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

/**
 * Which bound fired, in the words `authentication_events.reason` records.
 *
 * A runtime array rather than a bare union, because two places need the *values*: the type
 * below, and `countRecentFailures`, which must exclude exactly these reasons from the durable
 * lockout count (N-2). One list, so the query and the control cannot drift apart.
 */
export const SIGN_IN_ABUSE_REASONS = [
  'source_throttled',
  'source_account_throttled',
  'global_throttled',
] as const;

export type SignInAbuseReason = (typeof SIGN_IN_ABUSE_REASONS)[number];

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
 * 45 is borrowed from the *width* of `authentication_events.ip`
 * (`migrations/0004_credentials.sql`) — the widest string that column was ever meant to hold —
 * rather than from anything about the row this refusal writes. The two used to drift, and this
 * comment used to say so: `record()` passes `context.ip` and `recordAuthenticationEvent`
 * inserted it **untruncated**, so a value long enough to be clamped here was a row the database
 * rejected on its own terms — D08 **follow-up 1**. D09 closed that in `0f779fb`: the repository
 * now clamps `ip` to 45 and `userAgent` to 255 **by code point** at the insert, so the key and
 * the row are bounded the same way and an over-long value can no longer turn a refused sign-in
 * into a 500. They are still two clamps rather than one derived from the other — nothing here
 * reads the column's width back at runtime — and the database cases in
 * `test/id-002-credentials.db.test.ts` are what keep them in step.
 *
 * 45 is also the *exact* maximum length of an IPv4-mapped IPv6 literal
 * (`0000:…:0000:255.255.255.255`), so the widest real address fits with nothing to spare, and a
 * zone identifier (`%eth0`) on such an address is past it and would be clamped. Neither shape
 * reaches this API in the bootstrap profile, and the cost if one did is a shared key rather
 * than a wrong decision — but "fits well inside it" was wrong and is not worth keeping.
 *
 * What the bound is genuinely for is the other case: a forwarded token of arbitrary length.
 * Since D09 that can only arrive through a proxy the operator trusts, which is a narrower
 * opening than "anyone who can set a header" — but it is not closed, because `request.ip` is
 * then the last untrusted entry *verbatim* and no layer between the socket and this module
 * checks that it is an address at all. A caller behind an appending proxy can still rotate
 * kilobyte-long values, and without this clamp those would grow these maps in bytes while
 * staying inside their bound in entries.
 */
const MAX_SOURCE_KEY_LENGTH = 45;

interface Charge {
  readonly admitted: boolean;
  readonly firstRefusalInWindow: boolean;
}

interface Budget {
  /** Would a charge at `at` be admitted? Reads only — nothing moves, nothing is evicted. */
  readonly test: (key: string, at: number) => boolean;
  /** Charge the key at `at`, folding the refusing-key memory into the answer. */
  readonly commit: (key: string, at: number) => Charge;
}

/**
 * One budget: the two-phase limiter, plus the memory of which keys are already refusing.
 *
 * The split exists for `admit` below, which holds three of these and must not spend any of them
 * until all three have answered. `test` is the question and mutates nothing; `commit` is the
 * charge. Both take the instant, so one decision samples the clock once.
 *
 * `firstRefusalInWindow` is derived rather than asked of the limiter, and it is still exact.
 * Every call that *charges* a key either admits it (clearing the mark) or refuses it, and a key
 * can only refuse after `max` admitted charges inside one window — the first of which cleared
 * any mark left from the window before. So the charges a key sees read admitted…admitted,
 * refused…refused, admitted, and clearing the mark on any admission is precisely "the window
 * turned". The calls a budget is merely *asked* about and not charged for cannot disturb that,
 * because they move nothing.
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
}): Budget => {
  const limiter = createTwoPhaseFixedWindowLimiter(options);
  // Insertion order is first-refusal order, and it is FIFO rather than the limiter's LRU: a
  // key's position here is never refreshed by a later refusal, so the first entry is the key
  // that started refusing longest ago.
  const refusing = new Set<string>();

  return {
    test: (key, at) => limiter.test(key, at),
    commit: (key, at) => {
      if (limiter.commit(key, at)) {
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
    },
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

  /** The refusal a budget's own charge produces, wearing that budget's reason. */
  const refuse = (reason: SignInAbuseReason, charge: Charge): SignInAbuseVerdict => ({
    admitted: false,
    reason,
    firstRefusalInWindow: charge.firstRefusalInWindow,
  });

  return {
    admit({ ip, account }) {
      // One clock sample for the whole decision, so the question and the charge cannot
      // straddle a window boundary between them.
      const at = shared.now();
      const trimmed = ip?.trim();
      const address =
        trimmed === undefined || trimmed === ''
          ? UNKNOWN_SOURCE
          : trimmed.slice(0, MAX_SOURCE_KEY_LENGTH);
      const bucket = account === undefined ? undefined : accountBucket(account);
      const accountKey = bucket === undefined ? undefined : `sa:${address}:${bucket}`;
      const sourceKey = `s:${address}`;

      // Phase one — ask, narrowest bound first, and stop at the first refusal. Nothing here
      // mutates a budget, so the keys that were merely consulted are untouched. Two things
      // follow, both deliberate. The recorded reason names the tightest key that is over
      // budget, which is what an operator reading the event row needs. And the only budget a
      // refused attempt spends is the one that refused it — wider keys are never reached, and
      // narrower ones were only asked. Charging wider let one address over its own source
      // budget spend the deployment's global budget with attempts it was not being served
      // (C-1); charging narrower left a person behind a shared address throttled past the end
      // of the window that actually refused them (N-1).
      if (accountKey !== undefined && !perSourceAccount.test(accountKey, at)) {
        return refuse('source_account_throttled', perSourceAccount.commit(accountKey, at));
      }
      if (!perSource.test(sourceKey, at)) {
        return refuse('source_throttled', perSource.commit(sourceKey, at));
      }
      if (!globalBudget.test(GLOBAL_KEY, at)) {
        return refuse('global_throttled', globalBudget.commit(GLOBAL_KEY, at));
      }

      // Phase two — every applicable budget admitted, so every one of them is charged. The
      // distributed spray the global key exists to catch is admitted by every source key by
      // construction, so it still spends `g` exactly as it always did.
      if (accountKey !== undefined) perSourceAccount.commit(accountKey, at);
      perSource.commit(sourceKey, at);
      globalBudget.commit(GLOBAL_KEY, at);
      return { admitted: true };
    },
  };
}
