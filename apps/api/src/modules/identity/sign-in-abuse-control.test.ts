import { describe, expect, it } from 'vitest';
import { createSignInAbuseControl } from './sign-in-abuse-control.js';
import type { SignInAbuseOptions, SignInAbuseReason } from './sign-in-abuse-control.js';
import { decideVerifyFirst } from './authentication.service.js';

/**
 * Every case drives an injected clock, so a window turn is an assignment rather than a wait,
 * and the budgets are the smallest numbers that still tell the cases apart — a test that
 * needed the production 30/10/600 would be measuring arithmetic, not the decision.
 */
const createControl = (overrides: Partial<SignInAbuseOptions> & { now: () => number }) =>
  createSignInAbuseControl({
    windowMs: 300_000,
    maxPerSource: 30,
    maxPerSourceAccount: 10,
    maxGlobal: 600,
    ...overrides,
  });

describe('the sign-in abuse control', () => {
  it('admits maxPerSource attempts from one address, refuses the next, and leaves another address alone', () => {
    const control = createControl({ maxPerSource: 3, now: () => 1_000 });

    expect([
      control.admit({ ip: '198.51.100.7' }).admitted,
      control.admit({ ip: '198.51.100.7' }).admitted,
      control.admit({ ip: '198.51.100.7' }).admitted,
    ]).toEqual([true, true, true]);

    const refused = control.admit({ ip: '198.51.100.7' });
    expect(refused).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });

    // A second address carries its own window: one noisy office does not refuse the world.
    expect(control.admit({ ip: '203.0.113.9' }).admitted).toBe(true);
  });

  it('self-heals when the window turns rather than locking the address out', () => {
    let clock = 1_000;
    const control = createControl({ windowMs: 300_000, maxPerSource: 2, now: () => clock });

    control.admit({ ip: '198.51.100.7' });
    control.admit({ ip: '198.51.100.7' });
    expect(control.admit({ ip: '198.51.100.7' }).admitted).toBe(false);

    clock += 300_000;
    expect(control.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
  });

  it('refuses on the source+account budget first when one address grinds one account', () => {
    const control = createControl({ maxPerSource: 30, maxPerSourceAccount: 3, now: () => 5_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(control.admit({ ip: '198.51.100.7', account: 'ana@example.test' }).admitted).toBe(
        true,
      );
    }

    // The source budget is nowhere near 30, so the reason names the tightest bound that fired.
    expect(control.admit({ ip: '198.51.100.7', account: 'ana@example.test' })).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('names the narrowest bound even when the source budget has been crossed too', () => {
    // The discriminating case for the precedence in `admit`. One address, one account, and a
    // source budget only one wider than the account budget, so the two cross on consecutive
    // attempts and the fourth attempt is over *both*.
    const control = createControl({ maxPerSource: 3, maxPerSourceAccount: 2, now: () => 5_000 });
    const attempt = () => control.admit({ ip: '198.51.100.7', account: 'ana@example.test' });

    expect([attempt().admitted, attempt().admitted]).toEqual([true, true]);

    // Third: the account budget of 2 is crossed while the source is still inside its 3.
    expect(attempt()).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: true,
    });

    // Fourth: the account budget is still the one that answers, and its flag is already
    // spent. Reading the source budget first — or charging it on the third attempt, which
    // was refused before it reached the source key — would put the source key at its own
    // boundary here and report `source_throttled` with `firstRefusalInWindow: true`. So both
    // fields discriminate narrowest-first from source-first.
    expect(attempt()).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: false,
    });
  });

  it('keys nothing on a whitespace-only account, rather than giving every blank one bucket', () => {
    // `maxPerSourceAccount: 1` would refuse the second attempt if whitespace produced a key;
    // `maxPerSource: 30` is nowhere near, so the source budget cannot be what admits it.
    const control = createControl({ maxPerSource: 30, maxPerSourceAccount: 1, now: () => 5_000 });

    expect([
      control.admit({ ip: '198.51.100.7', account: '   ' }).admitted,
      control.admit({ ip: '198.51.100.7', account: '   ' }).admitted,
    ]).toEqual([true, true]);
  });

  it('charges the source budget across accounts, so a spray over rotating accounts is refused by it', () => {
    const control = createControl({ maxPerSource: 4, maxPerSourceAccount: 10, now: () => 5_000 });

    // Four attempts over four distinct synthetic accounts: no account key is near its own
    // budget of 10, which is exactly the hole the per-user lockout leaves open.
    for (const account of [
      'a@example.test',
      'b@example.test',
      'c@example.test',
      'd@example.test',
    ]) {
      expect(control.admit({ ip: '198.51.100.7', account }).admitted).toBe(true);
    }

    expect(control.admit({ ip: '198.51.100.7', account: 'e@example.test' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('catches a spray from rotating addresses on the global budget, which no address rotation evades', () => {
    const maxGlobal = 5;
    const control = createControl({ maxPerSource: 30, maxGlobal, now: () => 5_000 });

    for (let attempt = 0; attempt < maxGlobal; attempt += 1) {
      // A fresh address each time: the source key never comes close to its own budget.
      expect(control.admit({ ip: `198.51.100.${String(attempt)}` }).admitted).toBe(true);
    }

    expect(control.admit({ ip: `198.51.100.${String(maxGlobal)}` })).toEqual({
      admitted: false,
      reason: 'global_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('reports firstRefusalInWindow exactly once per key per window — the flag one event row hangs on', () => {
    let clock = 1_000;
    const control = createControl({ maxPerSource: 1, now: () => clock });

    expect(control.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
    expect(control.admit({ ip: '198.51.100.7' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(control.admit({ ip: '198.51.100.7' })).toEqual({
        admitted: false,
        reason: 'source_throttled',
        firstRefusalInWindow: false,
      });
    }

    clock += 300_000;
    expect(control.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
    expect(control.admit({ ip: '198.51.100.7' })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('buckets a missing address under one key rather than admitting it unbounded', () => {
    const control = createControl({ maxPerSource: 2, now: () => 5_000 });

    expect(control.admit({ ip: null }).admitted).toBe(true);
    expect(control.admit({ ip: undefined }).admitted).toBe(true);
    expect(control.admit({ ip: null })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('reads one account through casing and surrounding whitespace, the way the lookup does', () => {
    const control = createControl({ maxPerSource: 30, maxPerSourceAccount: 2, now: () => 5_000 });

    expect(control.admit({ ip: '198.51.100.7', account: 'Ana@Example.TEST' }).admitted).toBe(true);
    expect(control.admit({ ip: '198.51.100.7', account: '  ana@example.test  ' }).admitted).toBe(
      true,
    );
    expect(control.admit({ ip: '198.51.100.7', account: 'ANA@EXAMPLE.TEST' })).toEqual({
      admitted: false,
      reason: 'source_account_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('keeps distinct accounts in distinct buckets and cannot be made to collide through the key delimiter', () => {
    const control = createControl({ maxPerSource: 30, maxPerSourceAccount: 2, now: () => 5_000 });

    // Two different accounts from one address do not share a budget.
    control.admit({ ip: '198.51.100.7', account: 'ana@example.test' });
    control.admit({ ip: '198.51.100.7', account: 'ana@example.test' });
    expect(control.admit({ ip: '198.51.100.7', account: 'bo@example.test' }).admitted).toBe(true);

    // The account reaches the key as a hash, so a caller cannot spend someone else's budget
    // by typing the delimiter: concatenated raw, `198.51.100.4` + `x:ana@…` and
    // `198.51.100.4:x` + `ana@…` would be the same string.
    const ground = createControl({ maxPerSource: 30, maxPerSourceAccount: 1, now: () => 5_000 });
    expect(ground.admit({ ip: '198.51.100.4:x', account: 'ana@example.test' }).admitted).toBe(true);
    expect(ground.admit({ ip: '198.51.100.4', account: 'x:ana@example.test' }).admitted).toBe(true);
  });

  /**
   * C1 (final review, 2026-09-07). The two halves of conditional charging. Together they say
   * exactly what the global key is and is not: a bound on *served* attempts, which a
   * distributed spray still reaches and a single refused address never does.
   */
  it('does not charge the global budget for refused attempts, so one address cannot deny the deployment', () => {
    // The production numbers, because the number is the finding: 601 attempts from one address
    // is about two requests a second, and before conditional charging every one of them
    // charged `g` and the 601st refused everybody for the rest of the window.
    const control = createControl({ maxPerSource: 30, maxGlobal: 600, now: () => 5_000 });
    const attacker = '198.51.100.7';

    for (let attempt = 0; attempt < 601; attempt += 1) control.admit({ ip: attacker });

    // The attacker is still refused, and still by its own source key — nothing was weakened.
    expect(control.admit({ ip: attacker })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: false,
    });

    // And the third party, who has done nothing, is admitted: only the 30 attempts the source
    // key served ever reached `g`.
    expect(control.admit({ ip: '203.0.113.9' }).admitted).toBe(true);
  });

  it('still spends the global budget on admitted attempts from distinct addresses', () => {
    // The distributed spray the global key exists to catch: every address is inside its own
    // budget, so every attempt is admitted, so every attempt charges `g`.
    const control = createControl({ maxPerSource: 2, maxGlobal: 5, now: () => 5_000 });

    // First, ten attempts from one address: two admitted (charging `g` twice), eight refused
    // and charging it nothing.
    for (let attempt = 0; attempt < 10; attempt += 1) control.admit({ ip: '198.51.100.7' });

    // Three more distinct addresses, all admitted, take `g` from 2 to its budget of 5.
    for (const octet of [1, 2, 3]) {
      expect(control.admit({ ip: `203.0.113.${String(octet)}` }).admitted).toBe(true);
    }

    // The fourth crosses it — the global key still does its job.
    expect(control.admit({ ip: '203.0.113.4' })).toEqual({
      admitted: false,
      reason: 'global_throttled',
      firstRefusalInWindow: true,
    });
  });

  /**
   * N-1 (re-review of 2026-09-07). The other half of conditional charging: a refusal by a
   * *wider* key must not spend a *narrower* one either.
   *
   * The scenario needs no attacker. An office shares one egress address; colleagues spend the
   * source budget early in its window; the next person to try has never signed in from there
   * and is refused by the source key. Before the two-phase charge, each of her retries charged
   * her own `sa:` key — a budget that had refused nothing — so her account window started late,
   * outlived the source window that had actually refused her, and left her throttled after her
   * colleagues were signing in again. That falsified the module's own "refused for the
   * remainder of one window and never longer".
   */
  it('does not charge a narrower budget for an attempt a wider one refused', () => {
    let clock = 0;
    const control = createControl({
      windowMs: 300_000,
      maxPerSource: 4,
      maxPerSourceAccount: 3,
      // Never the bound that fires here; this case is about the other two.
      maxGlobal: 10_000,
      now: () => clock,
    });
    const OFFICE = '203.0.113.7';
    const alice = { ip: OFFICE, account: 'alice@example.test' };
    const refusal = (reason: SignInAbuseReason, firstRefusalInWindow: boolean) => ({
      admitted: false,
      reason,
      firstRefusalInWindow,
    });

    // t=0s. Four colleagues, four accounts, one address: the source budget is spent and no
    // account budget is anywhere near its own.
    for (const who of ['bo', 'cyd', 'dee', 'eli']) {
      expect(control.admit({ ip: OFFICE, account: `${who}@example.test` }).admitted).toBe(true);
    }

    // t=200s. Alice's first attempt from this address, ever. The source key refuses it.
    clock = 200_000;
    expect(control.admit(alice)).toEqual(refusal('source_throttled', true));

    // She retries, the way a person does when a login says to wait a few minutes. Every one of
    // these is refused by the *source* key and must leave her account budget alone — charging
    // it would turn the fourth retry into `source_account_throttled`, which is what the
    // pre-fix module reported and what this assertion pins.
    for (const at of [210_000, 220_000, 230_000]) {
      clock = at;
      expect(control.admit(alice)).toEqual(refusal('source_throttled', false));
    }

    // t=300s. The source window turns and the office can sign in again — and so can Alice.
    // On the pre-fix module her own account window ran from t=200s to t=500s and was already
    // spent, so she stayed refused for ~500 s on a 300 s window.
    clock = 300_000;
    expect(control.admit(alice).admitted).toBe(true);

    // And her budget is whole rather than merely non-empty: the full three admitted attempts,
    // and only then does her own key refuse and name itself.
    expect([control.admit(alice).admitted, control.admit(alice).admitted]).toEqual([true, true]);
    expect(control.admit(alice)).toEqual(refusal('source_account_throttled', true));
  });

  it('keeps the reason narrowest-first while a global refusal spends neither narrower budget', () => {
    let clock = 5_000;
    const control = createControl({
      // Both address-keyed budgets are crossable by this scenario, and that is the point of
      // the numbers. At `maxPerSource: 100` the source key could never be reached, so half of
      // what this title claims — that a global refusal spends *neither* narrower budget — was
      // asserted for the account key alone and not for the source key at all.
      maxPerSource: 3,
      maxPerSourceAccount: 2,
      maxGlobal: 3,
      now: () => clock,
    });
    const OFFICE = '203.0.113.50';
    const alice = { ip: OFFICE, account: 'alice@example.test' };
    const bo = { ip: OFFICE, account: 'bo@example.test' };
    const cyd = { ip: OFFICE, account: 'cyd@example.test' };
    const refusal = (reason: SignInAbuseReason, firstRefusalInWindow: boolean) => ({
      admitted: false,
      reason,
      firstRefusalInWindow,
    });

    // Three distinct addresses spend the global budget, all admitted.
    for (const octet of [1, 2, 3]) {
      expect(control.admit({ ip: `198.51.100.${String(octet)}` }).admitted).toBe(true);
    }

    // Nobody at the office has spent anything. The global key refuses every one of these and
    // goes on naming itself however long they retry. The pre-fix module charged the narrower
    // keys on each: the office's `s:` key crossed on the fourth of these attempts and Alice's
    // own `sa:` key on the fifth, so the same traffic reported `source_throttled` and then
    // `source_account_throttled` — narrower reasons for a refusal the global key made, and two
    // budgets spent on attempts nobody was served.
    expect(control.admit(alice)).toEqual(refusal('global_throttled', true));
    for (const attempt of [bo, cyd, alice, alice]) {
      expect(control.admit(attempt)).toEqual(refusal('global_throttled', false));
    }

    // The window turns, and both narrower budgets are whole rather than merely non-empty. Each
    // is spent to its own boundary to prove it. Alice's account budget first: two admitted
    // attempts, the whole of `maxPerSourceAccount`.
    clock += 300_000;
    expect([control.admit(alice).admitted, control.admit(alice).admitted]).toEqual([true, true]);

    // Then the office's source budget, of which those two have spent two. The third attempt
    // from this address names a different account, so the account key cannot be what answers,
    // and it is admitted: the full `maxPerSource` of three.
    expect(control.admit(bo).admitted).toBe(true);

    // Only now does the source key refuse, and it names itself ahead of the global key — which
    // those same three admitted attempts have also spent. Precedence is unchanged by the fix:
    // of the keys that are over budget, the narrowest is the one that names itself.
    expect(control.admit(cyd)).toEqual(refusal('source_throttled', true));

    // And narrower still. Alice's own account key is over too, so her next attempt is reported
    // under it rather than under the source or global key that are equally over.
    expect(control.admit(alice)).toEqual(refusal('source_account_throttled', true));
  });

  /**
   * I4 (final review, 2026-09-07). Under D09, where a proxy is trusted, `request.ip` is the
   * right-most `X-Forwarded-For` token no trusted peer wrote, taken verbatim, and fastify does
   * not validate it as an address — so wherever a caller can reach that position the key
   * material is attacker-chosen and unbounded in length until this clamp bounds it.
   */
  it('clamps the source address to 45 characters, so a forged header cannot grow the keys by bytes', () => {
    const control = createControl({ maxPerSource: 1, now: () => 5_000 });
    // Exactly 45 characters — the width of `authentication_events.ip`.
    const prefix = '203.0.113.9'.padEnd(45, '0');
    const forged = (fill: string) => `${prefix}${fill.repeat(5_000)}`;

    expect(forged('a')).toHaveLength(5_045);

    // Two five-kilobyte strings that differ only past character 45 share one budget, which is
    // what "the key is clamped" means from the outside: the first is admitted, the second is
    // refused by the very same key.
    expect(control.admit({ ip: forged('a') }).admitted).toBe(true);
    expect(control.admit({ ip: forged('b') })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });

    // And the clamp is a truncation, not a collapse: an address that differs *inside* the
    // first 45 characters still carries its own window.
    expect(
      control.admit({ ip: `${'198.51.100.7'.padEnd(45, '0')}${'a'.repeat(5_000)}` }).admitted,
    ).toBe(true);
  });

  /**
   * M7 / m2 (final review, 2026-09-07). The one branch of `createBudget` nothing executed: the
   * refusing-key set at its own ceiling, dropping the key that started refusing longest ago.
   *
   * `maxKeys: 2` rather than 1, because 1 cannot show the effect. The set and the limiter's
   * window map share the ceiling, and with one slot each the limiter always evicts a key's
   * window at the same moment the set would evict its mark — the key comes back admitted and
   * there is nothing to observe. Two slots let the two orders diverge, which is the point: the
   * set is FIFO by first refusal, the limiter is LRU by last touch, so a key can lose its mark
   * while its window is still live and over budget. That is the "one extra row per eviction"
   * caveat this module states in three places, and here it is, on a clock that never moves.
   */
  it('drops the oldest refusing key when its set is full, at the price of one extra row', () => {
    const control = createControl({ maxPerSource: 1, maxKeys: 2, now: () => 5_000 });
    const [a, b, c] = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];

    // `SignInAbuseVerdict` is a discriminated union, so a refusal is read as a whole object
    // rather than by reaching for a field the admitted arm does not have.
    const refusal = (reason: SignInAbuseReason, firstRefusalInWindow: boolean) => ({
      admitted: false,
      reason,
      firstRefusalInWindow,
    });

    expect(control.admit({ ip: a }).admitted).toBe(true);
    expect(control.admit({ ip: a })).toEqual(refusal('source_throttled', true));
    expect(control.admit({ ip: b }).admitted).toBe(true);
    expect(control.admit({ ip: b })).toEqual(refusal('source_throttled', true));

    // Touching `a` again makes it the most recently *seen* key and leaves it the oldest
    // *refusing* one — the divergence the eviction paths are about.
    expect(control.admit({ ip: a })).toEqual(refusal('source_throttled', false));

    // `c` arrives: the limiter drops `b`'s window (least recently seen), `a`'s survives.
    expect(control.admit({ ip: c }).admitted).toBe(true);
    // `c` refuses, and the refusing set is now full, so it drops `a`'s mark (first refused).
    expect(control.admit({ ip: c })).toEqual(refusal('source_throttled', true));

    // `a` is still inside the same window and still over its budget of 1 — the clock has not
    // moved — but its mark is gone, so it reports a first refusal a second time. One extra
    // event row for `a` in this window: more than the bound says, never fewer, and bounded by
    // the eviction rate rather than by the attempt rate.
    expect(control.admit({ ip: a })).toEqual({
      admitted: false,
      reason: 'source_throttled',
      firstRefusalInWindow: true,
    });
  });

  it('lets an evicted window start again — the limiter caveat, priced as "a little more, never less"', () => {
    const control = createControl({ maxPerSource: 1, maxKeys: 1, now: () => 5_000 });

    expect(control.admit({ ip: '198.51.100.1' }).admitted).toBe(true);
    expect(control.admit({ ip: '198.51.100.1' }).admitted).toBe(false);

    // One slot, so a second address evicts the first address's window rather than queueing.
    expect(control.admit({ ip: '198.51.100.2' }).admitted).toBe(true);

    // The first address comes back with a fresh window inside the same five minutes. That is
    // the documented direction of error: a caller is admitted a little more than the budget
    // says, and never less.
    expect(control.admit({ ip: '198.51.100.1' }).admitted).toBe(true);
  });
});

/**
 * D08 follow-up 6. The source key aggregates IPv6 to its /64 network, so the 2^64 addresses one
 * /64 holds can no longer each buy their own budget. IPv4 is untouched, an IPv4-mapped IPv6
 * source meets the bare IPv4 it carries, and a source `isIP` cannot parse falls back to the
 * clamped literal it always used — never merged with a real network.
 */
describe('the sign-in abuse control aggregates IPv6 sources by /64 (D08 follow-up 6)', () => {
  const refusal = {
    admitted: false as const,
    reason: 'source_throttled' as SignInAbuseReason,
    firstRefusalInWindow: true,
  };

  it('shares one budget across a /64 and keeps distinct /64s independent', () => {
    const control = createControl({ maxPerSource: 1, now: () => 5_000 });
    // Two addresses in 2001:db8::/64, differing only past the /64 boundary and in casing.
    expect(control.admit({ ip: '2001:db8::1' }).admitted).toBe(true);
    expect(control.admit({ ip: '2001:DB8:0:0:ffff::2' })).toEqual(refusal);
    // A different /64 carries its own window — the aggregation is per-network, not global.
    expect(control.admit({ ip: '2001:db8:0:1::1' }).admitted).toBe(true);
  });

  it('leaves IPv4 keyed on the full address, unaffected by the /64 rule', () => {
    const control = createControl({ maxPerSource: 1, now: () => 5_000 });
    expect(control.admit({ ip: '198.51.100.7' }).admitted).toBe(true);
    // A neighbouring IPv4 is a distinct key — IPv4 is never aggregated.
    expect(control.admit({ ip: '198.51.100.8' }).admitted).toBe(true);
  });

  it('keys an IPv4-mapped IPv6 source as the IPv4 it carries', () => {
    const control = createControl({ maxPerSource: 1, now: () => 5_000 });
    expect(control.admit({ ip: '203.0.113.9' }).admitted).toBe(true);
    // Same host, so it meets the bare IPv4 in one budget rather than the ::ffff:0:0/96 sink.
    expect(control.admit({ ip: '::ffff:203.0.113.9' })).toEqual(refusal);
  });

  it('falls back to the clamped literal for a malformed source, never merged with a network', () => {
    const control = createControl({ maxPerSource: 1, now: () => 5_000 });
    expect(control.admit({ ip: 'not:an:address' }).admitted).toBe(true);
    // A real IPv6 /64 alongside it keeps its own window: the fallback is never a network key.
    expect(control.admit({ ip: '2001:db8::1' }).admitted).toBe(true);
    // The same malformed literal is refused by the very key it created — it still buckets.
    expect(control.admit({ ip: 'not:an:address' })).toEqual(refusal);
  });
});

/**
 * `C-1`, as amended by F20 (wave 9) — the durable per-user lockout, extracted from
 * `authentication.service.ts` so the property that closes the finding is provable without a
 * database. Before F20 a correct password or code was admitted through a full window, so the
 * lockout never changed whether any guess succeeded; that case encoded the defect and is now the
 * opposite assertion. A full window refuses every guess, right or wrong; the holder's way out is
 * password reset by email, which never consults this window. Below the bound nothing changed.
 */
describe('durable lockout decision (C-1 + F20)', () => {
  it('locks out a correct password once the window is full (F20)', () => {
    expect(
      decideVerifyFirst({ passwordCorrect: true, failuresInWindow: 99, maxFailuresInWindow: 5 }),
    ).toBe('locked_out');
    expect(
      decideVerifyFirst({ passwordCorrect: true, failuresInWindow: 5, maxFailuresInWindow: 5 }),
    ).toBe('locked_out');
  });

  it('admits a correct password below the bound', () => {
    expect(
      decideVerifyFirst({ passwordCorrect: true, failuresInWindow: 4, maxFailuresInWindow: 5 }),
    ).toBe('admit');
  });

  it('locks out a wrong password once the window is full', () => {
    expect(
      decideVerifyFirst({ passwordCorrect: false, failuresInWindow: 5, maxFailuresInWindow: 5 }),
    ).toBe('locked_out');
  });

  it('rejects a wrong password below the window as an ordinary failure', () => {
    expect(
      decideVerifyFirst({ passwordCorrect: false, failuresInWindow: 4, maxFailuresInWindow: 5 }),
    ).toBe('reject');
  });
});
