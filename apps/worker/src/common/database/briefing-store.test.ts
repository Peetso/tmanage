import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assembleBriefing,
  briefingSubjectKey,
  briefingViewerBase,
  capabilitiesFor,
} from '@tmanage/domain';
import type { BriefingSource, BriefingSubject, OpenSignal } from '@tmanage/domain';
import { BRIEFING_SQL, findBriefingViewer, readBriefing } from './briefing-store.js';
import { createNotificationDigestStore } from './notification-digest-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';
import type { DigestRecipient, DigestWindow } from '../../jobs/notification-digest.js';
import { composeDigestEmail } from '../../notifications/digest-mailer.js';

/**
 * 62-A1c (B12) — the briefing section of the digest mail over a fake transaction: the same
 * statements as the Home card's repository, the card's scope rules (owner = company, lead = their
 * projects and people, money only with finance, guest = none), the mail section equal to the card
 * for the same person, and no mail when both the counts and the briefing are empty.
 */

const ORG = 'org-1';
const NOW = new Date('2026-11-19T06:10:00.000Z');
const SWEPT = new Date('2026-11-19T06:00:00.000Z');

interface Member {
  readonly id: string;
  readonly user_id: string;
  readonly role: string;
  readonly has_org_wide_scope: number;
  readonly workspace_scope_id: string | null;
}

const MEMBERS: Readonly<Record<string, Member>> = {
  'm-owner': member('m-owner', 'owner', 1),
  'm-lead': member('m-lead', 'member', 0),
  'm-manager': member('m-manager', 'manager', 0),
  'm-guest': member('m-guest', 'guest', 0),
  'm-plain': member('m-plain', 'member', 0),
};

function member(id: string, role: string, orgWide: number): Member {
  return { id, user_id: `u-${id}`, role, has_org_wide_scope: orgWide, workspace_scope_id: null };
}

const SIGNAL_ROWS = [
  row('s1', 'stale_task', 'work_item', 'w1', 'p1', 16),
  row('s2', 'overdue_invoice', 'client_invoice', 'i1', 'p1', 12),
  row('s3', 'overloaded_person', 'membership', 'm-omar', null, 115),
  row('s4', 'stale_task', 'work_item', 'w2', 'p2', 9),
  row('s5', 'stale_task', 'work_item', 'w-gone', 'p1', 30),
];

function row(
  id: string,
  rule: string,
  subjectType: string,
  subjectId: string,
  projectId: string | null,
  measure: number,
) {
  return {
    id,
    rule_key: rule,
    subject_type: subjectType,
    subject_id: subjectId,
    project_id: projectId,
    measure,
    threshold: 7,
  };
}

/** The live records; `w-gone` was deleted, so it does not resolve. */
const SUBJECT_ROWS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  work_items: [
    { id: 'w1', title: 'Footer redesign', project_name: 'Souq website' },
    { id: 'w2', title: 'Beta build', project_name: 'Nile Bank app' },
  ],
  client_invoices: [
    {
      id: 'i1',
      number: 'INV-0038',
      total_minor: 500_000,
      paid_minor: 80_000,
      currency: 'USD',
      client_name: 'Cedar Foods',
    },
  ],
  memberships: [{ id: 'm-omar', display_name: 'Omar Adel' }],
};

interface FakeOptions {
  readonly sweptAt?: Date | null;
  readonly flagOn?: boolean;
  readonly unread?: readonly string[];
  readonly overrides?: readonly { capability: string; effect: string }[];
}

/** A transaction answering each statement by what it reads; every call is recorded. */
function fakeTx(options: FakeOptions = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const tx = {
    query: (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      const answer = (rows: readonly unknown[]) => Promise.resolve(rows);
      if (sql === BRIEFING_SQL.member) {
        const found = MEMBERS[String(params[1])];
        return answer(found === undefined ? [] : [found]);
      }
      if (sql === BRIEFING_SQL.overrides) return answer(options.overrides ?? []);
      if (sql === BRIEFING_SQL.memberProjects) {
        return answer(
          params[1] === 'u-m-lead' || params[1] === 'u-m-manager' ? [{ project_id: 'p1' }] : [],
        );
      }
      if (sql === BRIEFING_SQL.lastSweep) {
        const at = options.sweptAt === undefined ? SWEPT : options.sweptAt;
        return answer(at === null ? [] : [{ swept_at: at }]);
      }
      if (sql === BRIEFING_SQL.openSignals) return answer(SIGNAL_ROWS);
      if (sql === BRIEFING_SQL.reports) return answer([]);
      if (sql.startsWith('SELECT DISTINCT m.id')) {
        return answer(params.includes('p1') ? [{ id: 'm-omar' }] : []);
      }
      if (sql.includes('FROM work_items x')) return answer(SUBJECT_ROWS['work_items'] ?? []);
      if (sql.includes('FROM client_invoices i')) {
        return answer(SUBJECT_ROWS['client_invoices'] ?? []);
      }
      if (sql.includes('SELECT m.id, u.display_name')) {
        return answer(SUBJECT_ROWS['memberships'] ?? []);
      }
      if (sql.includes('FROM org_feature_flags ff')) {
        return answer(options.flagOn === false ? [] : [{ enabled: 1 }]);
      }
      if (sql.includes('FROM users u')) {
        return answer([
          {
            email: 'amal@example.com',
            display_name: 'Amal',
            locale: 'en',
            email_enabled: 1,
            quiet_hours_start: null,
            quiet_hours_end: null,
            quiet_hours_timezone: null,
          },
        ]);
      }
      if (sql.startsWith('SELECT type FROM notifications')) {
        return answer((options.unread ?? []).map((type) => ({ type })));
      }
      if (sql.includes('notification_kind_prefs') || sql.includes('notification_matrix')) {
        return answer([]);
      }
      if (sql.startsWith('INSERT INTO notifications')) return answer([]);
      if (sql.startsWith('SELECT id FROM notifications')) return answer([{ id: params[1] }]);
      if (sql.startsWith('SELECT name, slug FROM organizations')) {
        return answer([{ name: 'Atlas Studio', slug: 'atlas' }]);
      }
      return answer([]);
    },
  } as unknown as WorkerTransaction;
  return { tx, calls };
}

/** The card's side: the domain reads over the same fixtures, the API principal's viewer rules. */
async function cardFor(role: Member['role'], membershipId: string, projectIds: string[]) {
  const signals: OpenSignal[] = SIGNAL_ROWS.map((r) => ({
    signalId: r.id,
    rule: r.rule_key as OpenSignal['rule'],
    subjectType: r.subject_type as OpenSignal['subjectType'],
    subjectId: r.subject_id,
    projectId: r.project_id,
    measure: r.measure,
    threshold: r.threshold,
  }));
  const subject = (title: string, context: string | null): BriefingSubject => ({
    title,
    context,
    amount: null,
    category: null,
    deliverableId: null,
  });
  const subjects = new Map<string, BriefingSubject>([
    [briefingSubjectKey('work_item', 'w1'), subject('Footer redesign', 'Souq website')],
    [briefingSubjectKey('work_item', 'w2'), subject('Beta build', 'Nile Bank app')],
    [
      briefingSubjectKey('client_invoice', 'i1'),
      { ...subject('INV-0038', 'Cedar Foods'), amount: { minor: 420_000, currency: 'USD' } },
    ],
    [briefingSubjectKey('membership', 'm-omar'), subject('Omar Adel', null)],
  ]);
  const source: BriefingSource = {
    team: (ids) => Promise.resolve(new Set(ids.includes('p1') ? ['m-omar'] : [])),
    lastSweep: () => Promise.resolve(SWEPT),
    openSignals: () => Promise.resolve(signals),
    subjects: () => Promise.resolve(subjects),
  };
  const capabilities = capabilitiesFor(role as Parameters<typeof capabilitiesFor>[0]);
  return assembleBriefing(
    source,
    briefingViewerBase({
      hasOrgWideScope: role === 'owner',
      holds: (capability) => capabilities.includes(capability),
      projectIds,
      membershipId,
    }),
  );
}

const counts = (groups: readonly { group: string; count: number }[]) =>
  Object.fromEntries(groups.map((g) => [g.group, g.count]));

describe('briefing store: the same statements as the Home card', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const api = readFileSync(
    join(ROOT, 'apps/api/src/modules/home/home-briefing.repository.ts'),
    'utf8',
  );
  const asWritten = (sql: string, hole: string) => sql.replace(/IN \(\?\)/u, `IN (\${${hole}})`);

  it.each(['lastSweep', 'openSignals', 'reports'] as const)('%s is copied verbatim', (key) => {
    expect(api).toContain(BRIEFING_SQL[key]);
  });

  it.each([
    ['teamOnProjects', 'marks(projects)'],
    ['work_item', 'marks(ids)'],
    ['membership', 'marks(ids)'],
    ['client_invoice', 'marks(ids)'],
    ['project', 'marks(ids)'],
    ['expense', 'marks(ids)'],
    ['approval', 'marks(ids)'],
  ] as const)('%s is copied verbatim', (key, hole) => {
    expect(api).toContain(asWritten(BRIEFING_SQL[key](1), hole));
  });

  it('no statement reads the database clock; the override expiry is bound', () => {
    for (const value of Object.values(BRIEFING_SQL)) {
      const sql = typeof value === 'string' ? value : value(2);
      expect(sql).not.toMatch(/NOW\(|CURRENT_TIMESTAMP/iu);
    }
  });
});

describe('briefing store: the viewer, as the card resolves it', () => {
  it('owner: company-wide with finance, no project read', async () => {
    const { tx, calls } = fakeTx();
    const viewer = await findBriefingViewer(tx, ORG, 'm-owner', NOW);
    expect(viewer).toMatchObject({ companyWide: true, finance: true });
    expect(calls.some((c) => c.sql === BRIEFING_SQL.memberProjects)).toBe(false);
  });

  it('a member is a lead only by holding project.manage (here an override), bound to now', async () => {
    const plain = await findBriefingViewer(fakeTx().tx, ORG, 'm-lead', NOW);
    expect([...(plain?.projectIds ?? [])]).toEqual([]);
    const { tx, calls } = fakeTx({
      overrides: [{ capability: 'project.manage', effect: 'allow' }],
    });
    const lead = await findBriefingViewer(tx, ORG, 'm-lead', NOW);
    expect(lead).toMatchObject({ companyWide: false, finance: false });
    expect([...(lead?.projectIds ?? [])]).toEqual(['p1']);
    expect(calls.find((c) => c.sql === BRIEFING_SQL.overrides)?.params).toEqual([
      ORG,
      'm-lead',
      NOW,
    ]);
  });

  it('a guest and an unknown membership have no briefing', async () => {
    expect(await findBriefingViewer(fakeTx().tx, ORG, 'm-guest', NOW)).toBeNull();
    expect(await findBriefingViewer(fakeTx().tx, ORG, 'm-nobody', NOW)).toBeNull();
  });
});

describe('briefing store: the mail section equals the card for the same person', () => {
  it('owner: the whole company, money included; the deleted task is not counted', async () => {
    const mail = await readBriefing(fakeTx().tx, ORG, 'm-owner', NOW);
    const card = await cardFor('owner', 'm-owner', []);
    expect(mail).toEqual(card);
    expect(counts(mail?.groups ?? [])).toEqual({
      money_to_collect: 1,
      people_overloaded: 1,
      stale_work: 2,
    });
  });

  it('manager on p1 (lead with finance): p1 and its people, the money line of p1', async () => {
    const mail = await readBriefing(fakeTx().tx, ORG, 'm-manager', NOW);
    expect(mail).toEqual(await cardFor('manager', 'm-manager', ['p1']));
    expect(counts(mail?.groups ?? [])).toEqual({
      money_to_collect: 1,
      people_overloaded: 1,
      stale_work: 1,
    });
  });

  it('lead without finance: no money line at all', async () => {
    const { tx } = fakeTx({ overrides: [{ capability: 'project.manage', effect: 'allow' }] });
    const mail = await readBriefing(tx, ORG, 'm-lead', NOW);
    expect(counts(mail?.groups ?? [])).toEqual({ people_overloaded: 1, stale_work: 1 });
    expect(mail?.groups.flatMap((g) => g.lines).some((l) => l.amount !== null)).toBe(false);
  });

  it('a member who leads nothing: audience none, no signal read', async () => {
    const { tx, calls } = fakeTx();
    const mail = await readBriefing(tx, ORG, 'm-plain', NOW);
    expect(mail).toEqual({ audience: 'none', asOf: null, groups: [] });
    expect(calls.some((c) => c.sql === BRIEFING_SQL.openSignals)).toBe(false);
  });
});

describe('digest store: the briefing section (62-A1c)', () => {
  const database = (tx: WorkerTransaction) =>
    ({
      read: (work: (t: WorkerTransaction) => Promise<unknown>) => work(tx),
      transaction: (work: (t: WorkerTransaction) => Promise<unknown>) => work(tx),
    }) as unknown as WorkerDatabase;
  const recipient = (patch: Partial<DigestRecipient> = {}): DigestRecipient => ({
    organizationId: ORG,
    membershipId: 'm-owner',
    userId: 'u-m-owner',
    cadence: 'daily',
    sendHour: 8,
    dayOfWeek: 1,
    timezone: 'Africa/Cairo',
    businessBriefing: true,
    ...patch,
  });
  const window: DigestWindow = {
    since: new Date('2026-11-18T06:10:00.000Z'),
    key: 'digest:daily:2026-11-19',
    cadence: 'daily',
    at: NOW,
  };
  const links = (path: string) => `https://app.example${path}`;
  const claims = (calls: readonly { sql: string }[]) =>
    calls.filter((c) => c.sql.startsWith('INSERT INTO notifications')).length;

  it('nothing unread but a briefing: one mail, the briefing only, linked into the workspace', async () => {
    const { tx, calls } = fakeTx();
    const facts = await createNotificationDigestStore(database(tx)).collectAndClaim(
      recipient(),
      window,
      links,
    );
    expect(claims(calls)).toBe(1);
    expect(facts?.counts).toEqual({});
    expect(facts?.briefing?.homeLink).toBe('https://app.example/atlas');
    expect(facts?.briefing?.groups.map((g) => g.link)).toEqual([
      'https://app.example/atlas/finance/invoices',
      'https://app.example/atlas/people/capacity',
      'https://app.example/atlas/work',
    ]);
    const mail = composeDigestEmail(facts!);
    expect(mail.subject).toBe('Your business briefing for Atlas Studio');
    expect(mail.text).toContain('Business briefing — As of 08:00');
    expect(mail.text).toContain('Money to collect (1)');
    expect(mail.text).toContain('• INV-0038 · Cedar Foods: $4,200.00, 12 days overdue');
    expect(mail.text).toContain('• Footer redesign · Souq website: No change for 16 days');
    expect(mail.text).toContain('• Omar Adel: 115% of their capacity planned this week');
    expect(mail.text).not.toContain('Here is what happened');
  });

  it('nothing unread and nothing open: nothing claimed, nothing sent', async () => {
    const { tx, calls } = fakeTx({ sweptAt: null });
    const facts = await createNotificationDigestStore(database(tx)).collectAndClaim(
      recipient(),
      window,
      links,
    );
    expect(facts).toBeNull();
    expect(claims(calls)).toBe(0);
  });

  it('switched off (the default) or flag off: no briefing read at all', async () => {
    for (const [who, options] of [
      [recipient({ businessBriefing: false }), {}],
      [recipient(), { flagOn: false }],
    ] as const) {
      const { tx, calls } = fakeTx(options);
      const facts = await createNotificationDigestStore(database(tx)).collectAndClaim(
        who,
        window,
        links,
      );
      expect(facts).toBeNull();
      expect(calls.some((c) => c.sql === BRIEFING_SQL.openSignals)).toBe(false);
    }
  });

  it('a lead without finance gets no money line in the mail', async () => {
    const { tx } = fakeTx({ overrides: [{ capability: 'project.manage', effect: 'allow' }] });
    const facts = await createNotificationDigestStore(database(tx)).collectAndClaim(
      recipient({ membershipId: 'm-lead', userId: 'u-m-lead' }),
      window,
      links,
    );
    const text = composeDigestEmail(facts!).text;
    expect(text).toContain('What needs you on your projects.');
    expect(text).not.toContain('INV-0038');
    expect(text).not.toContain('Money to collect');
  });
});
