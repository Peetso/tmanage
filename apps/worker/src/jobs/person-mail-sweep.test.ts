import { capabilitySetFor } from '@tmanage/domain';
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
  decidePersonMail,
  memberLanguage,
  sweepPersonMail,
  type MemberFactsPart,
  type PersonMailCandidate,
  type PersonMailMemberState,
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
