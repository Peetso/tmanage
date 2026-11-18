import { capabilitySetFor } from '@tmanage/domain';
import { MailRecipientSuppressedError } from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { describe, expect, it } from 'vitest';
import {
  PERSON_MAIL_CATALOG,
  newsKind,
  type FeatureNewsNote,
  type PersonMailFacts,
} from '../notifications/person-mail-catalog.js';
import {
  AFTER_NEW_DEVICE_ID,
  PERSON_MAIL_MAX_ATTEMPTS,
  decidePersonMail,
  failedAttemptOutcome,
  memberLanguage,
  sweepPersonMail,
  type MemberFactsPart,
  type PersonMailCandidate,
  type PersonMailMemberState,
  type PersonMailOutcome,
  type PersonMailRetry,
  type PersonMailStore,
  type WorkspaceFactsPart,
} from './person-mail-sweep.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-18T10:00:00.000Z');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

/** A settled workspace where every feature is already in use: nothing is due by default. */
function facts(overrides: Partial<PersonMailFacts> = {}): PersonMailFacts {
  return {
    now: NOW,
    workspaceCreatedAt: ago(60),
    joinedAt: ago(60),
    activeMembers: 5,
    openTeamInvitations: 0,
    ownStaleInvitations: 0,
    workspaceUsed: new Set([
      'projects',
      'work_items',
      'client_portal',
      'files',
      'approvals',
      'storage',
      'time_tracking',
      'meetings',
      'documents',
      'decisions',
      'client_requests',
      'automations',
      'automation_schedules',
      'doc_templates',
      'report_schedules',
      'custom_reports',
      'glossary',
      'doc_collections',
      'meeting_actions',
      'custom_roles',
      'checklist_templates',
      'work_labels',
      'snapshots',
      'metric_alerts',
      'objectives',
      'meeting_series',
      'webhooks',
      'announcements',
      'teams',
      'invoices',
      'quotes',
      'expenses',
      'retainers',
      'timesheets',
      'forms',
      'inbound_mail',
    ]),
    personalUsed: new Set([
      'saved_searches',
      'insight_views',
      'focus_blocks',
      'doc_bookmarks',
      'saved_messages',
      'inbox_filters',
      'calendar_connection',
    ]),
    tenFiles: false,
    hasSignInPolicy: true,
    workspaceLastSignInAt: ago(0),
    userLastSignInAt: ago(0),
    newDeviceNoticeAt: null,
    profileTimezoneSet: true,
    ...overrides,
  };
}

const state = (sent: Record<string, Date> = {}, tipsEnabled = true): PersonMailMemberState => ({
  sent: new Map(Object.entries(sent)),
  tipsEnabled,
});

const decide = (
  input: Partial<{
    role: string;
    facts: PersonMailFacts;
    state: PersonMailMemberState;
    switchOn: boolean;
    kinds: typeof PERSON_MAIL_CATALOG;
  }> = {},
) =>
  decidePersonMail({
    kinds: input.kinds ?? PERSON_MAIL_CATALOG,
    role: input.role ?? 'member',
    facts: input.facts ?? facts(),
    state: input.state ?? state(),
    switchOn: input.switchOn ?? true,
  });

const only = (...ids: string[]) => PERSON_MAIL_CATALOG.filter((kind) => ids.includes(kind.id));

const withoutInvoices = (): PersonMailFacts => {
  const base = facts();
  const used = new Set(base.workspaceUsed);
  used.delete('invoices');
  return { ...base, workspaceUsed: used };
};

describe('decidePersonMail', () => {
  it('sends nothing in a member’s first 24 hours, security follow-up included', () => {
    expect(decide({ facts: facts({ joinedAt: ago(0.5), newDeviceNoticeAt: ago(2) }) })).toBeNull();
  });

  it('offers a feature only to a role that may use it, and never to a client', () => {
    expect(capabilitySetFor('owner').has('finance.manage')).toBe(true);
    const kinds = only('feature:invoices');
    expect(decide({ kinds, role: 'owner', facts: withoutInvoices() })?.kind.id).toBe(
      'feature:invoices',
    );
    const memberMay = capabilitySetFor('member').has('finance.manage');
    expect(decide({ kinds, role: 'member', facts: withoutInvoices() })?.kind.id ?? null).toBe(
      memberMay ? 'feature:invoices' : null,
    );
    expect(decide({ kinds, role: 'client_admin', facts: withoutInvoices() })).toBeNull();
    expect(decide({ kinds, role: 'platform_support', facts: withoutInvoices() })).toBeNull();
  });

  it('keeps an owner-only kind from admins and members', () => {
    const kinds = only('security:owner_policy');
    const open = facts({ workspaceCreatedAt: ago(30), hasSignInPolicy: false });
    expect(decide({ kinds, role: 'owner', facts: open })?.kind.id).toBe('security:owner_policy');
    expect(decide({ kinds, role: 'org_admin', facts: open })).toBeNull();
    expect(decide({ kinds, role: 'member', facts: open })).toBeNull();
  });

  it('sends each tip once, ever', () => {
    const due = withoutInvoices();
    expect(
      decide({
        kinds: only('feature:invoices'),
        role: 'owner',
        facts: due,
        state: state({ 'feature:invoices': ago(40) }),
      }),
    ).toBeNull();
  });

  it('spaces normal mail 3 days in the first fortnight, then 7 days', () => {
    const young = { ...withoutInvoices(), workspaceCreatedAt: ago(10) };
    expect(decide({ role: 'owner', facts: young, state: state({ x: ago(2) }) })).toBeNull();
    expect(decide({ role: 'owner', facts: young, state: state({ x: ago(3) }) })).not.toBeNull();
    const settled = withoutInvoices();
    expect(decide({ role: 'owner', facts: settled, state: state({ x: ago(6) }) })).toBeNull();
    expect(decide({ role: 'owner', facts: settled, state: state({ x: ago(7) }) })).not.toBeNull();
  });

  it('stops everything but the security follow-up when the preference is off', () => {
    const due = { ...withoutInvoices(), newDeviceNoticeAt: ago(2) };
    const off = state({}, false);
    expect(decide({ role: 'owner', facts: withoutInvoices(), state: off })).toBeNull();
    expect(decide({ role: 'owner', facts: due, state: off })?.kind.id).toBe(AFTER_NEW_DEVICE_ID);
  });

  it('sends nothing at all, the security follow-up included, when the switch is off', () => {
    const due = { ...facts(), newDeviceNoticeAt: ago(2) };
    expect(decide({ role: 'owner', facts: due, switchOn: false })).toBeNull();
    expect(decide({ role: 'owner', facts: due, switchOn: true })?.kind.id).toBe(
      AFTER_NEW_DEVICE_ID,
    );
  });

  it('sends the after-new-device follow-up per notice day, at most once per 30 days', () => {
    const kinds = only(AFTER_NEW_DEVICE_ID);
    const due = facts({ newDeviceNoticeAt: ago(2) });
    const first = decide({ kinds, facts: due });
    expect(first?.tipId).toBe(`${AFTER_NEW_DEVICE_ID}:${ago(2).toISOString().slice(0, 10)}`);
    expect(
      decide({ kinds, facts: due, state: state({ 'security:after_new_device:x': ago(10) }) }),
    ).toBeNull();
    expect(
      decide({ kinds, facts: due, state: state({ 'security:after_new_device:x': ago(31) }) })
        ?.tipId,
    ).toBe(first?.tipId);
  });

  it('delivers feature news outside the normal cap, at most one a day', () => {
    const note: FeatureNewsNote = {
      id: '0b2c6a4e-1f00-4c7a-9d55-3f1e2a7b8c90',
      titleEn: 'Boards',
      titleAr: 'اللوحات',
      bodyEn: 'Boards are here.',
      bodyAr: 'وصلت اللوحات.',
      link: '/work',
    };
    const kinds = [newsKind(note)];
    const id = newsKind(note).id;
    expect(id.length).toBeLessThanOrEqual(40);
    expect(decide({ kinds, state: state({ x: ago(1) }) })?.kind.id).toBe(id);
    expect(decide({ kinds, state: state({ 'news:other': ago(0.5) }) })).toBeNull();
    expect(decide({ kinds, state: state({ [id]: ago(3) }) })).toBeNull();
  });
});

describe('the catalog', () => {
  it('has unique ids that fit the tip log, a link and both languages for every kind', () => {
    const ids = PERSON_MAIL_CATALOG.map((kind) => kind.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of PERSON_MAIL_CATALOG) {
      expect(kind.id.length, kind.id).toBeLessThanOrEqual(40);
      expect(kind.link, kind.id).toMatch(/^\/[a-z]/u);
      for (const copy of [kind.copy.en, kind.copy.ar]) {
        expect(copy.subject.trim(), kind.id).not.toBe('');
        expect(copy.lines.length, kind.id).toBeGreaterThan(0);
        expect(copy.button.trim(), kind.id).not.toBe('');
      }
      expect(kind.copy.ar.subject, kind.id).toMatch(/[؀-ۿ]/u);
      if (!kind.enabled) expect(kind.disabledReason, kind.id).toBeTruthy();
    }
  });

  it('asks no security reader for a code or a password, and links only to settings', () => {
    for (const kind of PERSON_MAIL_CATALOG.filter((k) => k.topic === 'security')) {
      const text = [...kind.copy.en.lines, kind.copy.en.subject].join(' ');
      expect(text, kind.id).not.toMatch(/\b\d{6}\b|enter (?:the|your) code|sign in here/iu);
      expect(kind.link, kind.id).not.toMatch(/sign-in|login|reset/iu);
    }
  });
});

describe('memberLanguage', () => {
  it('reads Arabic locales as Arabic and everything else as English', () => {
    expect(memberLanguage('ar')).toBe('ar');
    expect(memberLanguage('ar-EG')).toBe('ar');
    expect(memberLanguage('en-GB')).toBe('en');
    expect(memberLanguage(null)).toBe('en');
  });
});

describe('sweepPersonMail', () => {
  const candidate = (userId: string, role = 'owner'): PersonMailCandidate => ({
    organizationId: 'org-1',
    membershipId: `m-${userId}`,
    userId,
    role,
    email: `${userId}@example.test`,
    displayName: 'Sara',
    locale: 'en',
    slug: 'acme',
    workspaceName: 'Acme Studio',
  });

  function fakeStore(candidates: PersonMailCandidate[], claimOk = true) {
    const claimed: string[] = [];
    const cursors: (string | null)[] = [];
    let workspaceReads = 0;
    const base = withoutInvoices();
    const store: PersonMailStore = {
      tipsSwitchOn: () => Promise.resolve(true),
      readCursor: () => Promise.resolve(null),
      writeCursor: (userId) => {
        cursors.push(userId);
        return Promise.resolve();
      },
      listCandidates: (_after, limit) => Promise.resolve(candidates.slice(0, limit)),
      publishedNews: () => Promise.resolve([]),
      workspaceFacts: () => {
        workspaceReads += 1;
        const part: WorkspaceFactsPart = base;
        return Promise.resolve(part);
      },
      memberFacts: () => {
        const part: MemberFactsPart = { ...base, ...state() };
        return Promise.resolve(part);
      },
      claim: (c, tipId) => {
        claimed.push(`${c.userId}:${tipId}`);
        return Promise.resolve(claimOk);
      },
      dueRetries: () => Promise.resolve([]),
      reclaim: () => Promise.resolve(false),
      settle: () => Promise.resolve(),
    };
    return { store, claimed, cursors, workspaceReads: () => workspaceReads };
  }

  function recorder() {
    const sent: MailMessage[] = [];
    const mailer: Mailer = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve('sent' as const);
      },
    };
    return { mailer, sent };
  }

  it('claims, then sends one tip-keyed mail per member, signed through personRef', async () => {
    const fake = fakeStore([candidate('u1'), candidate('u2')]);
    const { mailer, sent } = recorder();
    const result = await sweepPersonMail({
      store: fake.store,
      mailer,
      webOrigin: 'https://tmanageapp.com/',
      now: NOW,
      batch: 2,
    });
    expect(result).toEqual({ looked: 2, sent: 2, wrapped: false });
    expect(fake.workspaceReads()).toBe(1);
    expect(fake.claimed).toEqual(['u1:feature:invoices', 'u2:feature:invoices']);
    expect(fake.cursors).toEqual(['u2']);
    expect(sent[0]).toMatchObject({
      to: 'u1@example.test',
      templateKey: 'tip',
      organizationId: 'org-1',
      personRef: { kind: 'assigned', userId: 'u1', topic: 'features' },
    });
    expect(sent[0]?.text).toContain('https://tmanageapp.com/acme/finance/invoices');
    expect(sent[0]?.text).toContain('Acme Studio');
  });

  it('sends nothing when another run already claimed the tip, and wraps a short batch', async () => {
    const fake = fakeStore([candidate('u1')], false);
    const { mailer, sent } = recorder();
    const result = await sweepPersonMail({
      store: fake.store,
      mailer,
      webOrigin: 'https://x.test',
      now: NOW,
    });
    expect(result).toEqual({ looked: 1, sent: 0, wrapped: true });
    expect(sent).toHaveLength(0);
    expect(fake.cursors).toEqual([null]);
  });
});

describe('MAILREST — person mail retried after a failed send, never sent twice', () => {
  const HOUR = 3_600_000;
  const member: PersonMailCandidate = {
    organizationId: 'org-1',
    membershipId: 'm-u1',
    userId: 'u1',
    role: 'owner',
    email: 'u1@example.test',
    displayName: 'Sara',
    locale: 'en',
    slug: 'acme',
    workspaceName: 'Acme Studio',
  };

  interface Row {
    status: 'sending' | 'sent' | 'retry' | 'gave_up';
    attempts: number;
    nextAttemptAt: Date | null;
    error: string | null;
    sentAt: Date;
  }

  /** A tip log that behaves like `mail_tip_log` with 0374: guarded claim, reclaim and settle. */
  function tipLog(options: { switchOn?: boolean; candidates?: PersonMailCandidate[] } = {}) {
    const rows = new Map<string, Row>();
    const base = withoutInvoices();
    const store: PersonMailStore = {
      tipsSwitchOn: () => Promise.resolve(options.switchOn ?? true),
      readCursor: () => Promise.resolve(null),
      writeCursor: () => Promise.resolve(),
      listCandidates: () => Promise.resolve(options.candidates ?? [member]),
      publishedNews: () => Promise.resolve([]),
      workspaceFacts: () => Promise.resolve(base),
      memberFacts: () => {
        const sent = new Map([...rows].map(([id, row]) => [id, row.sentAt]));
        return Promise.resolve({ ...base, sent, tipsEnabled: true });
      },
      claim: (_c, tipId, at) => {
        if (rows.has(tipId)) return Promise.resolve(false);
        rows.set(tipId, {
          status: 'sending',
          attempts: 1,
          nextAttemptAt: null,
          error: null,
          sentAt: at,
        });
        return Promise.resolve(true);
      },
      dueRetries: (now) => {
        const due: PersonMailRetry[] = [];
        for (const [tipId, row] of rows) {
          if (row.status === 'retry' && row.nextAttemptAt !== null && row.nextAttemptAt <= now) {
            due.push({ candidate: member, tipId, attempts: row.attempts });
          }
        }
        return Promise.resolve(due);
      },
      reclaim: (retry) => {
        const row = rows.get(retry.tipId);
        if (row?.status !== 'retry' || row.attempts !== retry.attempts)
          return Promise.resolve(false);
        row.status = 'sending';
        row.attempts += 1;
        row.nextAttemptAt = null;
        return Promise.resolve(true);
      },
      settle: (_c, tipId, attempts, outcome: PersonMailOutcome, at) => {
        const row = rows.get(tipId);
        if (row?.status !== 'sending' || row.attempts !== attempts) return Promise.resolve();
        row.status = outcome.status;
        row.nextAttemptAt = outcome.status === 'retry' ? outcome.nextAttemptAt : null;
        row.error = outcome.status === 'sent' ? null : outcome.error;
        if (outcome.status === 'sent') row.sentAt = at;
        return Promise.resolve();
      },
    };
    return { store, rows };
  }

  /** Fails the first `failures` sends with `error`, then accepts. */
  function flaky(failures: number, error: unknown = new Error('connection reset')) {
    const attempts: MailMessage[] = [];
    const mailer: Mailer = {
      send: (message) => {
        attempts.push(message);
        return attempts.length <= failures
          ? Promise.reject(error)
          : Promise.resolve('sent' as const);
      },
    };
    return { mailer, attempts };
  }

  const run = (store: PersonMailStore, mailer: Mailer, at: Date) =>
    sweepPersonMail({ store, mailer, webOrigin: 'https://tmanageapp.com', now: at });

  it('retries a failed send after the back-off, then records it sent', async () => {
    const log = tipLog();
    const { mailer, attempts } = flaky(1);
    expect((await run(log.store, mailer, NOW)).sent).toBe(0);
    expect(log.rows.get('feature:invoices')).toMatchObject({
      status: 'retry',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + HOUR),
      error: 'Error',
    });
    // Not yet due: nothing is sent again.
    await run(log.store, mailer, new Date(NOW.getTime() + HOUR / 2));
    expect(attempts).toHaveLength(1);
    const later = new Date(NOW.getTime() + HOUR);
    expect((await run(log.store, mailer, later)).sent).toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.text).toBe(attempts[0]?.text);
    expect(log.rows.get('feature:invoices')).toMatchObject({
      status: 'sent',
      attempts: 2,
      sentAt: later,
    });
  });

  it('gives up after the last attempt and never sends that tip again', async () => {
    const log = tipLog();
    const { mailer, attempts } = flaky(99);
    let at = NOW;
    for (let hour = 0; hour <= 40; hour += 1) {
      at = new Date(NOW.getTime() + hour * HOUR);
      await run(log.store, mailer, at);
    }
    expect(attempts).toHaveLength(PERSON_MAIL_MAX_ATTEMPTS);
    expect(log.rows.get('feature:invoices')).toMatchObject({
      status: 'gave_up',
      attempts: PERSON_MAIL_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
    await run(log.store, mailer, new Date(at.getTime() + 30 * 24 * HOUR));
    expect(attempts.filter((m) => m.text === attempts[0]?.text)).toHaveLength(
      PERSON_MAIL_MAX_ATTEMPTS,
    );
  });

  it('gives up at once on a suppressed address or a refused recipient', () => {
    const refused = Object.assign(new Error('rejected'), { command: 'RCPT TO', responseCode: 550 });
    expect(failedAttemptOutcome(new MailRecipientSuppressedError(), 1, NOW)).toEqual({
      status: 'gave_up',
      error: 'suppressed',
    });
    expect(failedAttemptOutcome(refused, 1, NOW)).toEqual({ status: 'gave_up', error: 'smtp_550' });
    expect(
      failedAttemptOutcome(Object.assign(new Error('x'), { responseCode: 451 }), 2, NOW),
    ).toEqual({
      status: 'retry',
      nextAttemptAt: new Date(NOW.getTime() + 4 * HOUR),
      error: 'smtp_451',
    });
  });

  it('sends a due retry once when two runs reach it (the re-claim has one winner)', async () => {
    const log = tipLog();
    const first = flaky(1);
    await run(log.store, first.mailer, NOW);
    const later = new Date(NOW.getTime() + HOUR);
    const { mailer, attempts } = flaky(0);
    // Both runs read the same due row before either re-claims it.
    const due = await log.store.dueRetries(later, 25);
    const racing: PersonMailStore = { ...log.store, dueRetries: () => Promise.resolve(due) };
    await Promise.all([run(racing, mailer, later), run(racing, mailer, later)]);
    expect(attempts).toHaveLength(1);
    expect(log.rows.get('feature:invoices')).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('never retries a row left mid-send, and sends no retry while the switch is off', async () => {
    const log = tipLog({ candidates: [] });
    log.rows.set('feature:invoices', {
      status: 'sending',
      attempts: 1,
      nextAttemptAt: null,
      error: null,
      sentAt: NOW,
    });
    const { mailer, attempts } = flaky(0);
    await run(log.store, mailer, new Date(NOW.getTime() + 2 * HOUR));
    expect(attempts).toHaveLength(0);

    const off = tipLog({ switchOn: false, candidates: [] });
    off.rows.set('feature:invoices', {
      status: 'retry',
      attempts: 1,
      nextAttemptAt: NOW,
      error: 'Error',
      sentAt: NOW,
    });
    await run(off.store, mailer, new Date(NOW.getTime() + 2 * HOUR));
    expect(attempts).toHaveLength(0);
    expect(off.rows.get('feature:invoices')?.status).toBe('retry');
  });
});
