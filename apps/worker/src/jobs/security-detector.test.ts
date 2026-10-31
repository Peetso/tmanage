import { describe, expect, it, vi } from 'vitest';
import type { Mailer } from '@tmanage/mail';
import { DETECTOR_RULES, runSecurityDetector } from './security-detector.js';
import type { PendingSignal, SecuritySignalStore, SignalRecord } from './security-detector.js';

const NOW = new Date('2026-10-31T12:07:00.000Z');
const ORG = '0190a000-0000-7000-8000-000000000001';
const OTHER = '0190a000-0000-7000-8000-000000000002';
const T = 5; // every rule's threshold in these tests

const setting = (ruleKey: string, enabled: boolean) => ({
  ...{ ruleKey, enabled, count: T, windowMinutes: 60, cooldownMinutes: 60 },
});

function fakeStore(n: number, over: Partial<SecuritySignalStore> = {}) {
  const upserts: SignalRecord[] = [];
  const at = <R>(row: R) => (n >= T ? [row] : []);
  const store: SecuritySignalStore = {
    rules: () => Promise.resolve(DETECTOR_RULES.map((r) => setting(r.key, true))),
    failedSignInsBySource: () => Promise.resolve(at({ source: '203.0.113.9', count: n })),
    refusedLinkCodes: () => Promise.resolve(at({ organizationId: ORG, ipHash: 'h', count: n })),
    saturatedBuckets: () => Promise.resolve(at({ bucketKey: 'sign_in:ip:m:x', count: n })),
    auditBursts: () => Promise.resolve(at({ organizationId: ORG, actorUserId: ORG, count: n })),
    webhookFailures: () => Promise.resolve(at({ organizationId: ORG, endpointId: ORG, count: n })),
    lastOkBackupAt: () => Promise.resolve(n >= T ? null : NOW),
    longSupportSessions: () => Promise.resolve(at({ id: OTHER, organizationId: ORG })),
    changedHeads: () => Promise.resolve(at({ organizationId: ORG, chainSeq: 2, headHash: 'b' })),
    chainTail: () =>
      Promise.resolve([
        { chainSeq: 2, prevHash: 'x', rowHash: 'b' },
        { chainSeq: 1, prevHash: null, rowHash: 'a' },
      ]),
    upsertSignal: (s) => Promise.resolve(void upserts.push(s)),
    pendingSignals: () => Promise.resolve([]),
    notifiedSince: () => Promise.resolve([]),
    lastDigestAt: () => Promise.resolve(null),
    ownerEmails: (org) => Promise.resolve([`owner@${org === ORG ? 'one' : 'two'}.test`]),
    markNotified: vi.fn(() => Promise.resolve()),
    markRulesFired: vi.fn(() => Promise.resolve()),
    ...over,
  };
  return { store, upserts };
}

const compose = vi.fn(() => ({ subject: 's', text: 't' }));
const deps = (store: SecuritySignalStore, sent: string[]) => ({
  store,
  mailer: {
    send: (m: { to: string }) => Promise.resolve(void sent.push(m.to)),
  } as unknown as Mailer,
  alertEmails: ['ops@platform.test'],
  composeDigest: compose,
  now: () => NOW,
});

const base = { ruleKey: 'permission_churn', subjectType: 'organization', count: 9, firstSeen: NOW };
const signal = (id: string, org: string | null, severity: 'high' | 'low'): PendingSignal => ({
  ...{ ...base, id, organizationId: org, scopeKey: org ?? 'platform', severity },
  ...{ subjectId: org, subjectKey: org ?? '-' },
});

describe('security detector rules', () => {
  it.each(DETECTOR_RULES.filter((r) => r.deferred === undefined).map((r) => r.key))(
    '%s fires at its threshold and is silent below',
    async (key) => {
      const fired = fakeStore(T);
      await runSecurityDetector(deps(fired.store, []));
      expect(fired.upserts.some((s) => s.ruleKey === key)).toBe(true);
      const quiet = fakeStore(T - 1);
      await runSecurityDetector(deps(quiet.store, []));
      expect(quiet.upserts.some((s) => s.ruleKey === key)).toBe(false);
    },
  );

  it('stores a hash, never the raw source IP, and never fires a disabled rule', async () => {
    const off = () => Promise.resolve([setting('rate_limit_saturation', false)]);
    const { store, upserts } = fakeStore(T, { rules: off });
    await runSecurityDetector(deps(store, []));
    expect(upserts).toHaveLength(0);
    const all = fakeStore(T);
    await runSecurityDetector(deps(all.store, []));
    expect(JSON.stringify(all.upserts)).not.toContain('sign_in:ip:m:x');
  });

  it('skips a deferred rule without an error even when its row is enabled', async () => {
    const read = vi.fn(() => Promise.reject(new Error('SELECT command denied')));
    const onRuleError = vi.fn();
    const on = () => Promise.resolve([setting('credential_stuffing', true)]);
    const { store, upserts } = fakeStore(T, { rules: on, failedSignInsBySource: read });
    await runSecurityDetector({ ...deps(store, []), onRuleError });
    expect(read).not.toHaveBeenCalled();
    expect(onRuleError).not.toHaveBeenCalled();
    expect(upserts).toHaveLength(0);
  });
});

describe('security alert dispatch', () => {
  it('batches pending signals into one platform mail; owners get only their own high rows', async () => {
    const sent: string[] = [];
    const pending = [
      signal('a', ORG, 'high'),
      signal('b', null, 'high'),
      signal('c', OTHER, 'low'),
    ];
    const { store } = fakeStore(0, { pendingSignals: () => Promise.resolve(pending) });
    const result = await runSecurityDetector(deps(store, sent));
    expect(sent).toEqual(['ops@platform.test', 'owner@one.test']);
    expect(result.mailed).toBe(2);
    const ownerMail = compose.mock.calls.at(-1) as unknown as [{ signals: PendingSignal[] }];
    expect(ownerMail[0].signals.map((s) => s.id)).toEqual(['a']);
  });

  it('waits out the 15-minute batch window and suppresses a repeat inside the cooldown', async () => {
    const sent: string[] = [];
    const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
    const pending = { ruleKey: 'permission_churn', scopeKey: ORG, subjectKey: ORG };
    const recent = fakeStore(0, {
      lastDigestAt: () => Promise.resolve(ago(5)),
      pendingSignals: () => Promise.resolve([signal('a', ORG, 'high')]),
    });
    expect((await runSecurityDetector(deps(recent.store, sent))).mailed).toBe(0);
    const cooling = fakeStore(0, {
      lastDigestAt: () => Promise.resolve(ago(20)),
      pendingSignals: () => Promise.resolve([signal('a', ORG, 'high')]),
      notifiedSince: () => Promise.resolve([{ ...pending, notifiedAt: ago(20) }]),
    });
    const result = await runSecurityDetector(deps(cooling.store, sent));
    expect(result).toMatchObject({ mailed: 0, suppressed: 1 });
    expect(sent).toEqual([]);
    expect(cooling.store.markNotified).toHaveBeenCalledWith(['a'], 'suppressed', NOW);
  });
});
