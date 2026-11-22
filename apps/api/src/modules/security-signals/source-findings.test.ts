import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_STUFFING,
  FINDING_RULE_DEFAULTS,
  GUARD_REFUSAL_BURST,
  SIGN_IN_AFTER_FAILURES,
  evaluateCredentialStuffing,
  evaluateGuardRefusalBurst,
  evaluateSignInAfterFailures,
  evaluateSourceFindings,
  sourceHash,
} from './source-findings.js';
import type { AuthEventRow } from './source-findings.js';
import { runSourceFindingsPass } from './source-findings-job.js';
import type { SourceFindingsStore } from './source-findings.repository.js';

/**
 * SEC-ALERTS. The two shapes of 2026-11-21 (SECURITY-INCIDENT-2026-11-21.md) are the fixtures:
 * the tester's 4 wrong passwords in 1 s then a throttle, the 4 CSRF refusals in 0.3 s, and the
 * signed-out tab that polled once a minute for 8 hours and must never page anyone.
 */

const NOW = new Date('2026-11-21T15:20:00.000Z');
const ATTACKER = '48.47.63.166';
const POLLER = '197.167.175.211';
const USER = '0190a000-0000-7000-8000-000000000001';
const at = (msBefore: number) => new Date(NOW.getTime() - msBefore);

const row = (over: Partial<AuthEventRow> & { readonly occurredAt: Date }): AuthEventRow => ({
  ip: ATTACKER,
  userId: USER,
  action: 'password_sign_in',
  outcome: 'failed',
  reason: 'bad_password',
  ...over,
});

const stuffing = FINDING_RULE_DEFAULTS[CREDENTIAL_STUFFING]!;
const guard = FINDING_RULE_DEFAULTS[GUARD_REFUSAL_BURST]!;
const success = FINDING_RULE_DEFAULTS[SIGN_IN_AFTER_FAILURES]!;

describe('credential_stuffing', () => {
  it('fires on 4 wrong passwords inside one second (velocity), hashed, counts only', () => {
    const rows = [0, 250, 500, 750].map((ms) => row({ occurredAt: at(60_000 - ms) }));
    const [finding, ...rest] = evaluateCredentialStuffing(rows, stuffing);
    expect(rest).toHaveLength(0);
    expect(finding).toMatchObject({
      ruleKey: CREDENTIAL_STUFFING,
      sourceHash: sourceHash(ATTACKER),
      count: 4,
      details: { failures: 4, accounts: 1, peak10s: 4, pattern: 'brute_force', throttled: 0 },
    });
    expect(JSON.stringify(finding)).not.toContain(ATTACKER);
    expect(JSON.stringify(finding)).not.toContain(USER);
  });

  it('fires on the throttle refusal even below the count', () => {
    const rows = [
      row({ occurredAt: at(300_000) }),
      row({ occurredAt: at(100_000), reason: 'source_account_throttled', userId: null }),
    ];
    expect(evaluateCredentialStuffing(rows, stuffing)[0]?.details['throttled']).toBe(1);
  });

  it('is silent for a person who mistypes three times over a few minutes', () => {
    const rows = [0, 60_000, 120_000].map((ms) => row({ occurredAt: at(ms) }));
    expect(evaluateCredentialStuffing(rows, stuffing)).toEqual([]);
  });

  it('labels many accounts from one source as enumeration', () => {
    const rows = [
      ...[1, 2, 3, 4].map((i) =>
        row({
          occurredAt: at(i * 60_000),
          userId: `0190a000-0000-7000-8000-00000000000${String(i)}`,
        }),
      ),
      row({ occurredAt: at(30_000), userId: null, reason: 'no_such_user' }),
    ];
    expect(evaluateCredentialStuffing(rows, stuffing)[0]?.details).toMatchObject({
      failures: 5,
      accounts: 4,
      unknownAccounts: 1,
      pattern: 'enumeration',
    });
  });

  it('ignores guard refusals', () => {
    const rows = [0, 1, 2, 3, 4].map((i) =>
      row({ occurredAt: at(i * 100), action: 'csrf_guard', reason: 'csrf_failed' }),
    );
    expect(evaluateCredentialStuffing(rows, stuffing)).toEqual([]);
  });
});

describe('guard_refusal_burst', () => {
  it('fires on 4 CSRF refusals within 0.3 s', () => {
    const rows = [0, 100, 200, 300].map((ms) =>
      row({
        occurredAt: at(600_000 - ms),
        action: 'csrf_guard',
        reason: 'csrf_failed',
        userId: null,
      }),
    );
    expect(evaluateGuardRefusalBurst(rows, guard)).toEqual([
      expect.objectContaining({
        ruleKey: GUARD_REFUSAL_BURST,
        sourceHash: sourceHash(ATTACKER),
        count: 4,
        details: expect.objectContaining({ csrf: 4, missingSession: 0 }) as unknown,
      }),
    ]);
  });

  it('never fires for a signed-out tab polling once a minute (the 2026-11-21 Egypt pattern)', () => {
    // 8 hours at the sampler's ceiling: one missing_session row per address per minute.
    const rows = Array.from({ length: 480 }, (_, i) =>
      row({
        ip: POLLER,
        userId: null,
        occurredAt: at(i * 60_000),
        action: 'session_guard',
        reason: 'missing_session',
      }),
    );
    expect(evaluateGuardRefusalBurst(rows, guard)).toEqual([]);
    expect(evaluateSourceFindings(rows, new Map(), NOW)).toEqual([]);
  });

  it('counts other guard reasons (a disabled account, a token outside its scopes)', () => {
    const rows = ['account_disabled', 'pat.scope_denied', 'pat.ip_denied', 'csrf_failed'].map(
      (reason, i) =>
        row({
          occurredAt: at(i * 1_000),
          action: i === 3 ? 'csrf_guard' : 'session_guard',
          reason,
        }),
    );
    expect(evaluateGuardRefusalBurst(rows, guard)[0]?.details).toMatchObject({
      csrf: 1,
      otherGuard: 3,
    });
  });
});

describe('sign_in_after_failures', () => {
  it('fires when a source gets in after 3 failures, and not after 2', () => {
    const failures = [4, 3, 2].map((m) => row({ occurredAt: at(m * 60_000) }));
    const signedIn = row({ occurredAt: at(30_000), outcome: 'succeeded', reason: null });
    expect(evaluateSignInAfterFailures([...failures, signedIn], success)).toEqual([
      expect.objectContaining({ ruleKey: SIGN_IN_AFTER_FAILURES, count: 3 }),
    ]);
    expect(evaluateSignInAfterFailures([...failures.slice(1), signedIn], success)).toEqual([]);
  });
});

describe('the pass', () => {
  it('reads one window, writes the findings bucketed by rule window, prunes', async () => {
    const written: { ruleKey: string; windowStart: Date }[] = [];
    let since: Date | null = null;
    let prunedBefore: Date | null = null;
    const store: SourceFindingsStore = {
      thresholds: () => Promise.resolve(new Map()),
      authEvents: (from) => {
        since = from;
        return Promise.resolve([0, 200, 400, 600].map((ms) => row({ occurredAt: at(ms) })));
      },
      writeFindings: (findings) => Promise.resolve(void written.push(...findings)),
      prune: (before) => Promise.resolve(void (prunedBefore = before)),
    };
    expect(await runSourceFindingsPass(store, NOW)).toEqual({ findings: 1 });
    // The longest default window is sign_in_after_failures' 60 minutes.
    expect(since).toEqual(at(60 * 60_000));
    expect(written).toEqual([
      expect.objectContaining({
        ruleKey: CREDENTIAL_STUFFING,
        windowStart: new Date('2026-11-21T15:20:00.000Z'),
      }),
    ]);
    expect(prunedBefore).toEqual(at(2 * 24 * 3_600_000));
  });

  it('skips a disabled rule', () => {
    const rows = [0, 200, 400, 600].map((ms) => row({ occurredAt: at(ms) }));
    const off = new Map([[CREDENTIAL_STUFFING, { ...stuffing, enabled: false }]]);
    expect(evaluateSourceFindings(rows, off, NOW)).toEqual([]);
  });
});
