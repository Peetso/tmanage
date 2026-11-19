import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { SIGNAL_RULE_KEYS, SIGNAL_RULES, uuidv7 } from '@tmanage/domain';
import type { BriefingGroup, Principal, SignalRuleKey } from '@tmanage/domain';
import { createWorkerDatabase } from '@tmanage/worker';
import type { SignalsSweepResult, SignalsSweepStore, WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { HomeBriefingRepository } from '../src/modules/home/home-briefing.repository.js';
import { HomeBriefingService } from '../src/modules/home/home-briefing.service.js';
import type { HomeBriefingView } from '../src/modules/home/home-briefing.service.js';
import { SignalSettingsRepository } from '../src/modules/insights/signals.repository.js';
import { SignalSettingsService } from '../src/modules/insights/signals.service.js';
import { MembershipResolver } from '../src/modules/tenancy/membership-resolver.repository.js';
import { PrincipalRepository } from '../src/modules/tenancy/principal.repository.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T1 2026-11-19 — the signals engine and the business briefing (B05, B11, B12; migration 0380) on
 * MariaDB 11.8, through the worker's real store and sweep, the real notice consumer, the API's
 * real services (principals resolved by the real membership resolver) and the worker's real
 * digest store. Every time is bound from {@link NOW}; nothing reads the database clock.
 *
 * 1. Each of the eight rules fires on rows built for it and stays silent just below its threshold.
 * 2. One signal per subject per 24 hours (two sweeps the same day = one row and one notice; 23 h
 *    later still one; 24 h later a second); a rule switched off still files (notify 0, no outbox);
 *    the `business_briefing` flag off files nothing; a cleared condition leaves the briefing at the
 *    next sweep; a settings save twice keeps one row per rule.
 * 3. Money notices reach `finance.view` holders only (per-member overrides included); the alert
 *    settings list no money rule to an owner without `finance.view`.
 * 4. The Home briefing scope matrix: owner, admin without finance, lead, lead with finance, member,
 *    client, guest; a deleted work item or archived project is not counted; the twin is separate.
 * 5. The digest's briefing section equals the Home briefing for the same person; no briefing and
 *    nothing unread claims nothing.
 */

// ── Clock ───────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A Wednesday, 10:00 UTC — before the real date, so the seed's own rows never look stale. */
const NOW = new Date('2026-06-10T10:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

// ── Worker modules, from source (the package entry is the built `dist`) ─────────

const HERE = dirname(fileURLToPath(import.meta.url));
const workerModule = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(HERE, '../../worker/src', path)).href)) as T;

type WorkerTx = Parameters<Parameters<WorkerDatabase['transaction']>[0]>[0];

interface ClaimedEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  readonly attempts: number;
}
interface SweeperModule {
  runSignalsSweep(deps: {
    store: SignalsSweepStore;
    now: Date;
    onError?: (error: unknown) => void;
  }): Promise<SignalsSweepResult>;
}
interface SignalsStoreModule {
  createSignalsStore(database: WorkerDatabase, env?: NodeJS.ProcessEnv): SignalsSweepStore;
}
interface NoticeModule {
  workSignalRaisedConsumer(event: ClaimedEvent, tx: WorkerTx): Promise<void>;
}
interface DigestRecipient {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly businessBriefing: boolean;
}
interface DigestFacts {
  readonly briefing?: {
    readonly audience: string;
    readonly asOf: Date;
    readonly groups: readonly (BriefingGroup & { readonly link: string })[];
  };
}
interface DigestStore {
  listRecipients(limit: number): Promise<readonly DigestRecipient[]>;
  collectAndClaim(
    recipient: DigestRecipient,
    window: { since: Date; key: string; cadence: 'daily'; at: Date },
    links: (path: string) => string,
  ): Promise<DigestFacts | null>;
}
interface DigestStoreModule {
  createNotificationDigestStore(database: WorkerDatabase): DigestStore;
}

// ── State ───────────────────────────────────────────────────────────────────

const RAISED = 'work_signal.raised.v1';
const DIGEST_SENT = 'notification.digest_sent';
const FLAG = 'business_briefing';

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;
let sweeper: SweeperModule;
let store: SignalsSweepStore;
let notices: NoticeModule;
let digests: DigestStore;
let resolver: MembershipResolver;
const principals = new PrincipalRepository();
const audit = { record: vi.fn(() => Promise.resolve({})) };
let briefings: HomeBriefingService;
let settings: SignalSettingsService;

/** The people this file adds to Northstar (Maya, Omar, Lina come from the seed). */
interface Person {
  readonly id: string;
  readonly membershipId: string;
}
let dana: Person; // deadline owner, 40 h a week
let eli: Person; // overloaded at exactly 110 %
let fay: Person; // one minute under 110 %
let sara: Person; // manager leading Atlas only, finance.view denied, Huda reports to her
let adil: Person; // org admin, finance.view denied
let tariq: Person; // member on the side project only
let huda: Person; // member on the side project, reports to Sara
let gus: Person; // internal guest

const northstar = () => world.northstar.organizationId;
const atlasProject = () => world.northstar.projectId;
const brandProject = () => world.northstar.otherProjectId;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

// ── Fixture rows (deleted again, newest first, by `removeFixtures`) ───────────

const fixtures: { table: string; id: string }[] = [];

type Cell = string | number | boolean | Date | null;

async function insert(table: string, row: Record<string, Cell>): Promise<string> {
  const id = typeof row['id'] === 'string' ? row['id'] : uuidv7();
  const full: Record<string, Cell> = { id, ...row };
  const columns = Object.keys(full);
  await db.admin.execute(
    `insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(full),
  );
  fixtures.push({ table, id });
  return id;
}

async function removeFixtures(): Promise<void> {
  while (fixtures.length > 0) {
    const { table, id } = fixtures.pop()!;
    await db.admin.execute(`delete from ${table} where id = ?`, [id]);
  }
}

/** Every trace of earlier sweeps: signals, stamps, settings, their outbox events and notices. */
async function resetSignals(): Promise<void> {
  await db.admin.query('delete from work_signals');
  await db.admin.query('delete from work_signal_sweeps');
  await db.admin.query('delete from work_signal_settings');
  await db.admin.execute('delete from outbox_events where type = ?', [RAISED]);
  await db.admin.execute('delete from notifications where type in (?, ?)', [RAISED, DIGEST_SENT]);
}

async function setFlag(organizationId: string, enabled: boolean): Promise<void> {
  await db.admin.execute(
    `insert into org_feature_flags (id, organization_id, flag_key, enabled) values (?, ?, ?, ?)
     on duplicate key update enabled = values(enabled)`,
    [uuidv7(), organizationId, FLAG, enabled ? 1 : 0],
  );
}

async function person(
  name: string,
  role: string,
  options: { orgWide?: boolean; projects?: readonly string[] } = {},
): Promise<Person> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into users (id, email, display_name, email_verified_at) values (?, ?, ?, ?)`,
    [id, `${name.toLowerCase()}.${id.slice(-6)}@northstar.example`, name, NOW],
  );
  const membershipId = uuidv7();
  await db.admin.execute(
    `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
     values (?, ?, ?, ?, ?)`,
    [membershipId, northstar(), id, role, options.orgWide === true],
  );
  for (const projectId of options.projects ?? []) await joinProject(projectId, id, false);
  return { id, membershipId };
}

async function joinProject(projectId: string, userId: string, fixture = true): Promise<void> {
  const row = { organization_id: northstar(), project_id: projectId, user_id: userId };
  if (fixture) await insert('project_memberships', row);
  else
    await db.admin.execute(
      `insert into project_memberships (id, organization_id, project_id, user_id)
       values (?, ?, ?, ?)`,
      [uuidv7(), row.organization_id, row.project_id, row.user_id],
    );
}

async function denyFinance(membershipId: string, createdBy: string): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into membership_permission_overrides
       (id, organization_id, membership_id, capability, effect, created_by, created_at)
     values (?, ?, ?, 'finance.view', 'deny', ?, ?)`,
    [id, northstar(), membershipId, createdBy, NOW],
  );
  return id;
}

const project = (name: string, organizationId = northstar(), workspaceId?: string) =>
  insert('projects', {
    organization_id: organizationId,
    workspace_id: workspaceId ?? world.northstar.workspaceId,
    name,
  });

async function workItem(input: {
  projectId: string;
  title: string;
  state?: string;
  ownerUserId?: string | null;
  dueAt?: Date | null;
  updatedAt?: Date;
  estimateMinutes?: number;
  organizationId?: string;
}): Promise<string> {
  const organizationId = input.organizationId ?? northstar();
  const id = await insert('work_items', {
    organization_id: organizationId,
    project_id: input.projectId,
    title: input.title,
    state: input.state ?? 'in_progress',
    owner_user_id: input.ownerUserId ?? null,
    due_at: input.dueAt ?? null,
    created_at: at(-60 * DAY),
    updated_at: input.updatedAt ?? NOW,
  });
  if (input.estimateMinutes !== undefined) {
    await insert('work_item_estimates', {
      organization_id: organizationId,
      work_item_id: id,
      estimate_minutes: input.estimateMinutes,
      created_at: NOW,
      updated_at: NOW,
    });
  }
  return id;
}

/** A stale work item: in progress, untouched for 20 days. */
const staleItem = (projectId: string, title: string, ownerUserId: string | null = null) =>
  workItem({ projectId, title, ownerUserId, updatedAt: at(-20 * DAY) });

const capacity = (membershipId: string, weeklyHours: number) =>
  insert('person_capacity', {
    organization_id: northstar(),
    membership_id: membershipId,
    weekly_hours: weeklyHours,
    effective_from: '2026-01-01',
  });

/** Owned work due in six days (inside the overload week, outside the deadline window). */
const plannedWork = (projectId: string, ownerUserId: string, minutes: number) =>
  workItem({
    projectId,
    title: 'Planned work',
    ownerUserId,
    dueAt: at(6 * DAY),
    estimateMinutes: minutes,
  });

const invoice = (input: { projectId: string; number: string; dueDate: string }) =>
  insert('client_invoices', {
    organization_id: northstar(),
    client_organization_id: world.atlas.clientOrganizationId,
    project_id: input.projectId,
    number: input.number,
    state: 'sent',
    issue_date: '2026-05-01',
    due_date: input.dueDate,
    currency: 'USD',
    base_currency: 'USD',
    total_minor: 420_000,
    paid_minor: 0,
    created_by: world.northstar.owner.id,
    created_at: at(-40 * DAY),
    updated_at: at(-40 * DAY),
  });

const budget = (projectId: string, budgetMinutes: number, usedMinutes: number) =>
  insert('project_budgets', {
    organization_id: northstar(),
    project_id: projectId,
    budget_type: 'hours',
    budget_minutes: budgetMinutes,
    used_minutes_cache: usedMinutes,
    created_by: world.northstar.owner.id,
    created_at: NOW,
    updated_at: NOW,
  });

const expense = (input: { spentOn: string; amountMinor: number; state?: string }) =>
  insert('expenses', {
    organization_id: northstar(),
    project_id: atlasProject(),
    membership_id: dana.membershipId,
    spent_on: input.spentOn,
    category: 'travel',
    amount_minor: input.amountMinor,
    currency: 'USD',
    amount_base_minor: input.amountMinor,
    state: input.state ?? 'approved',
    created_at: NOW,
    updated_at: NOW,
  });

/** A client approval requested at `requestedAt`, on a deliverable of the Atlas project. */
async function approval(requestedAt: Date, title: string): Promise<string> {
  const deliverableId = await insert('deliverables', {
    organization_id: northstar(),
    project_id: atlasProject(),
    title,
    created_by_user_id: world.northstar.owner.id,
    created_at: requestedAt,
    updated_at: requestedAt,
  });
  const versionId = await insert('deliverable_versions', {
    organization_id: northstar(),
    project_id: atlasProject(),
    deliverable_id: deliverableId,
    content_hash: 'a'.repeat(64),
    created_by_user_id: world.northstar.owner.id,
    created_at: requestedAt,
  });
  return insert('approvals', {
    organization_id: northstar(),
    project_id: atlasProject(),
    deliverable_id: deliverableId,
    deliverable_version_id: versionId,
    content_hash: 'a'.repeat(64),
    state: 'requested',
    reviewer_ids: '[]',
    created_at: requestedAt,
    updated_at: requestedAt,
  });
}

/** Two billable hours on an approved timesheet, on no invoice line, worked on `spentOn`. */
async function approvedTime(projectId: string, spentOn: string): Promise<void> {
  const timesheetId = await insert('timesheets', {
    organization_id: northstar(),
    membership_id: dana.membershipId,
    period_start: spentOn,
    period_end: spentOn,
    state: 'approved',
    created_at: NOW,
    updated_at: NOW,
  });
  await insert('work_item_time_logs', {
    organization_id: northstar(),
    project_id: projectId,
    logged_by: dana.id,
    minutes: 120,
    spent_on: spentOn,
    billable: 1,
    timesheet_id: timesheetId,
    created_at: NOW,
  });
}

// ── Running the worker ──────────────────────────────────────────────────────

/** One sweep of every company with the flag on, at `now`; a failed company fails the test. */
async function sweep(now: Date): Promise<number> {
  const errors: unknown[] = [];
  const result = await sweeper.runSignalsSweep({
    store,
    now,
    onError: (error) => errors.push(error),
  });
  expect(errors).toEqual([]);
  return result.filed;
}

interface StoredSignalRow {
  readonly id: string;
  readonly subject_id: string;
  readonly measure: number;
  readonly notify: number;
  readonly signal_day: string;
  readonly raised_at: Date;
  readonly seen_at: Date;
}

async function signalsOf(rule: SignalRuleKey, subjectId?: string): Promise<StoredSignalRow[]> {
  return (await rows(
    `select id, subject_id, measure, notify, date_format(signal_day, '%Y-%m-%d') as signal_day,
            raised_at, seen_at
       from work_signals
      where organization_id = ? and rule_key = ? and (? is null or subject_id = ?)
      order by raised_at, id`,
    [northstar(), rule, subjectId ?? null, subjectId ?? null],
  )) as unknown as StoredSignalRow[];
}

async function raisedEvents(signalId?: string): Promise<RowDataPacket[]> {
  return rows(
    `select id, organization_id, type, aggregate_id, payload_json, correlation_id, occurred_at
       from outbox_events where type = ? and (? is null or aggregate_id = ?) order by id`,
    [RAISED, signalId ?? null, signalId ?? null],
  );
}

async function sweptAt(organizationId: string): Promise<Date | null> {
  const found = await rows('select swept_at from work_signal_sweeps where organization_id = ?', [
    organizationId,
  ]);
  return (found[0]?.['swept_at'] as Date | undefined) ?? null;
}

/** Deliver every pending `work_signal.raised.v1` through the real consumer, one transaction each. */
async function deliverNotices(): Promise<void> {
  for (const row of await raisedEvents()) {
    const payload: unknown = row['payload_json'];
    const event: ClaimedEvent = {
      id: String(row['id']),
      organizationId: String(row['organization_id']),
      type: String(row['type']),
      schemaVersion: 1,
      aggregateType: 'work_signal',
      aggregateId: String(row['aggregate_id']),
      payload: typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload,
      correlationId: (row['correlation_id'] as string | null) ?? null,
      occurredAt: row['occurred_at'] as Date,
      attempts: 1,
    };
    await workerDb.transaction((tx) => notices.workSignalRaisedConsumer(event, tx));
  }
}

async function noticeRecipients(signalId: string): Promise<string[]> {
  const found = await rows(
    `select recipient_user_id from notifications
      where organization_id = ? and type = ? and object_id = ? order by recipient_user_id`,
    [northstar(), RAISED, signalId],
  );
  return found.map((row) => String(row['recipient_user_id'])).sort();
}

// ── Viewers through the API ─────────────────────────────────────────────────

async function viewer(
  userId: string,
  organizationId = northstar(),
): Promise<{ context: TenantContext; principal: Principal }> {
  const resolved = await resolver.resolve({
    userId,
    organization: { organizationId },
    correlationId: uuidv7(),
  });
  const principal = await tenant.read(resolved.context, (runner) =>
    principals.load(runner, resolved),
  );
  return { context: resolved.context, principal };
}

async function briefingOf(userId: string, organizationId = northstar()): Promise<HomeBriefingView> {
  const { context, principal } = await viewer(userId, organizationId);
  return briefings.briefingOf(context, principal);
}

/** Each drawn group with the subjects it lists and its count. */
function listed(view: HomeBriefingView): Record<string, { count: number; subjects: string[] }> {
  return Object.fromEntries(
    view.groups.map((group) => [
      group.group,
      { count: group.count, subjects: group.lines.map((line) => line.subjectId).sort() },
    ]),
  );
}

const sorted = (...ids: string[]): string[] => [...ids].sort();

/** A whole settings save: every rule at its default, with `patch` applied per rule. */
function settingsBody(
  patch: Partial<Record<SignalRuleKey, { enabled?: boolean; threshold?: number }>> = {},
  rules: readonly SignalRuleKey[] = SIGNAL_RULE_KEYS,
) {
  return {
    rules: rules.map((rule) => ({
      rule,
      enabled: patch[rule]?.enabled ?? true,
      threshold: patch[rule]?.threshold ?? SIGNAL_RULES[rule].threshold.defaultValue,
      recipient: SIGNAL_RULES[rule].defaultRecipient,
    })),
  };
}

async function saveSettings(body: unknown): Promise<void> {
  const owner = await viewer(world.northstar.owner.id);
  await settings.update(owner.context, owner.principal, body);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({
    url: db.workerUrl,
    connectionLimit: 3,
    statementTimeoutMs: 15_000,
  });
  world = await seedTwoTenants(db.admin);
  sweeper = await workerModule<SweeperModule>('jobs/signals-sweeper.js');
  store = (
    await workerModule<SignalsStoreModule>('common/database/signals-store.js')
  ).createSignalsStore(workerDb, {});
  notices = await workerModule<NoticeModule>('consumers/work-signal-notice.js');
  digests = (
    await workerModule<DigestStoreModule>('common/database/notification-digest-store.js')
  ).createNotificationDigestStore(workerDb);
  resolver = new MembershipResolver(tenant);
  briefings = new HomeBriefingService(tenant, new HomeBriefingRepository());
  settings = new SignalSettingsService({
    database: tenant,
    audit: audit as unknown as ConstructorParameters<typeof SignalSettingsService>[0]['audit'],
    repository: new SignalSettingsRepository(),
    now: () => NOW,
  });

  dana = await person('Dana', 'member', { projects: [atlasProject()] });
  eli = await person('Eli', 'member', { projects: [atlasProject()] });
  fay = await person('Fay', 'member', { projects: [atlasProject()] });
  sara = await person('Sara', 'manager', { projects: [atlasProject()] });
  adil = await person('Adil', 'org_admin', { orgWide: true });
  tariq = await person('Tariq', 'member');
  huda = await person('Huda', 'member');
  gus = await person('Gus', 'guest', { projects: [atlasProject()] });
  await denyFinance(sara.membershipId, world.northstar.owner.id);
  await denyFinance(adil.membershipId, world.northstar.owner.id);
  await db.admin.execute(
    `insert into member_reporting_lines (id, organization_id, member_id, manager_member_id)
     values (?, ?, ?, ?)`,
    [uuidv7(), northstar(), huda.membershipId, sara.membershipId],
  );
  await setFlag(northstar(), true);
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('62-27 the eight rules on real rows (one sweep at NOW)', () => {
  /** Per rule: the subject built to fire and its sibling just below the threshold. */
  const cases = {} as Record<SignalRuleKey, { fires: string; below: string; measure: number }>;

  beforeAll(async () => {
    await resetSignals();
    await capacity(dana.membershipId, 40);
    await capacity(eli.membershipId, 10);
    await capacity(fay.membershipId, 10);

    // 1 — 20 h left, due in 2 days, 40 h a week (≈11.4 h until due). The sibling needs as much
    // but is due 1 minute beyond the 5-day window.
    cases.deadline_at_risk = {
      fires: await workItem({
        projectId: atlasProject(),
        title: 'Due soon, does not fit',
        ownerUserId: dana.id,
        dueAt: at(2 * DAY),
        estimateMinutes: 1_200,
      }),
      below: await workItem({
        projectId: atlasProject(),
        title: 'Due just outside the window',
        ownerUserId: dana.id,
        dueAt: at(5 * DAY + MINUTE),
        estimateMinutes: 1_200,
      }),
      measure: 2,
    };
    // 2 — 660 of 600 weekly minutes = 110 %; 659 is one minute under.
    await plannedWork(atlasProject(), eli.id, 660);
    await plannedWork(atlasProject(), fay.id, 659);
    cases.overloaded_person = { fires: eli.membershipId, below: fay.membershipId, measure: 110 };
    // 3 — due 7 days 10 h ago vs 6 days 10 h ago (threshold 7 days).
    cases.overdue_invoice = {
      fires: await invoice({ projectId: atlasProject(), number: 'T1-0001', dueDate: '2026-06-03' }),
      below: await invoice({ projectId: atlasProject(), number: 'T1-0002', dueDate: '2026-06-04' }),
      measure: 7,
    };
    // 4 — 6 000 of 6 000 budget minutes = 100 %; 5 999 is just under.
    const overBudget = await project('Budget at 100%');
    const underBudget = await project('Budget at 99.98%');
    await budget(overBudget, 6_000, 6_000);
    await budget(underBudget, 6_000, 5_999);
    cases.project_over_budget = { fires: overBudget, below: underBudget, measure: 100 };
    // 5 — untouched 14 days vs 14 days less a minute.
    cases.stale_task = {
      fires: await workItem({
        projectId: atlasProject(),
        title: 'Idle 14 days',
        updatedAt: at(-14 * DAY),
      }),
      below: await workItem({
        projectId: atlasProject(),
        title: 'Idle 13 days 23 h 59 min',
        updatedAt: at(-14 * DAY + MINUTE),
      }),
      measure: 14,
    };
    // 6 — the category's usual is 10.00 (median of the 90 days before): 30.00 is 3×, 29.99 is not.
    for (const day of ['2026-05-01', '2026-05-02', '2026-05-03']) {
      await expense({ spentOn: day, amountMinor: 1_000 });
    }
    cases.unusual_expense = {
      fires: await expense({ spentOn: '2026-06-08', amountMinor: 3_000, state: 'submitted' }),
      below: await expense({ spentOn: '2026-06-08', amountMinor: 2_999, state: 'submitted' }),
      measure: 3,
    };
    // 7 — requested 3 days ago vs 3 days less a minute (threshold 3 days).
    cases.approval_waiting_on_client = {
      fires: await approval(at(-3 * DAY), 'Homepage concepts'),
      below: await approval(at(-3 * DAY + MINUTE), 'Booking flow concepts'),
      measure: 3,
    };
    // 8 — the oldest approved, unbilled hour was worked 14 days ago vs 13 (threshold 14 days).
    const unbilledLong = await project('Unbilled 14 days');
    const unbilledShort = await project('Unbilled 13 days');
    await approvedTime(unbilledLong, '2026-05-27');
    await approvedTime(unbilledShort, '2026-05-28');
    cases.approved_time_not_invoiced = { fires: unbilledLong, below: unbilledShort, measure: 14 };

    await sweep(NOW);
  });

  afterAll(async () => {
    await removeFixtures();
    await resetSignals();
  });

  it.each(SIGNAL_RULE_KEYS)('%s fires at its threshold and not just below it', async (rule) => {
    const { fires, below, measure } = cases[rule];
    const filed = await signalsOf(rule, fires);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ measure, notify: 1, signal_day: '2026-06-10' });
    expect(await signalsOf(rule, below)).toEqual([]);
  });
});

describe('62-27 / 62-A1b one signal per subject per 24 hours, the switches, the clearing', () => {
  let item: string;

  beforeEach(async () => {
    await resetSignals();
    item = await staleItem(atlasProject(), 'Waiting on copy', world.northstar.designer.id);
  });

  afterEach(async () => {
    await setFlag(northstar(), true);
    await removeFixtures();
  });

  it('two sweeps the same day keep one row and one notice; seen_at and the sweep stamp move', async () => {
    await sweep(NOW);
    await sweep(at(HOUR));

    const filed = await signalsOf('stale_task', item);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.raised_at).toEqual(NOW);
    expect(filed[0]!.seen_at).toEqual(at(HOUR));
    expect(await raisedEvents(filed[0]!.id)).toHaveLength(1);
    expect(await sweptAt(northstar())).toEqual(at(HOUR));
  });

  it('23 hours later (the next UTC day) is still one signal; 24 hours later raises the second', async () => {
    await sweep(NOW);
    await sweep(at(23 * HOUR));
    const held = await signalsOf('stale_task', item);
    expect(held.map((row) => row.signal_day)).toEqual(['2026-06-10']);
    expect(held[0]!.seen_at).toEqual(at(23 * HOUR));
    expect(await raisedEvents()).toHaveLength(1);

    await sweep(at(24 * HOUR));
    const again = await signalsOf('stale_task', item);
    expect(again.map((row) => row.signal_day)).toEqual(['2026-06-10', '2026-06-11']);
    expect(again[1]!.raised_at).toEqual(at(24 * HOUR));
    expect(await raisedEvents()).toHaveLength(2);
  });

  it('a rule switched off still files its signal, with notify 0 and no outbox event', async () => {
    await saveSettings(settingsBody({ stale_task: { enabled: false } }));
    await sweep(NOW);

    const filed = await signalsOf('stale_task', item);
    expect(filed).toHaveLength(1);
    expect(filed[0]!.notify).toBe(0);
    expect(await raisedEvents(filed[0]!.id)).toEqual([]);
  });

  it('with business_briefing off the sweep files nothing and stamps nothing', async () => {
    await setFlag(northstar(), false);
    expect(await sweep(NOW)).toBe(0);

    expect(
      await rows('select id from work_signals where organization_id = ?', [northstar()]),
    ).toEqual([]);
    expect(await sweptAt(northstar())).toBeNull();
  });

  it('before the first sweep the briefing has no "as of" and lists nothing', async () => {
    const view = await briefingOf(world.northstar.owner.id);
    expect(view).toEqual({ audience: 'company', asOf: null, groups: [] });
  });

  it('a condition that cleared is not listed after the next sweep', async () => {
    await sweep(NOW);
    expect(listed(await briefingOf(world.northstar.owner.id))['stale_work']?.subjects).toContain(
      item,
    );

    // Someone moves the task on; the next hourly sweep no longer finds it.
    await db.admin.execute('update work_items set updated_at = ? where id = ?', [
      at(30 * MINUTE),
      item,
    ]);
    await sweep(at(HOUR));

    const view = await briefingOf(world.northstar.owner.id);
    expect(view.asOf).toBe(at(HOUR).toISOString());
    expect(listed(view)['stale_work']).toBeUndefined();
  });

  it('saving the settings twice keeps one row per rule, holding the second save', async () => {
    await saveSettings(settingsBody());
    await saveSettings(
      settingsBody({ stale_task: { threshold: 21 }, overdue_invoice: { enabled: false } }),
    );

    const saved = await rows(
      `select rule_key, enabled, threshold from work_signal_settings
        where organization_id = ? order by rule_key`,
      [northstar()],
    );
    expect(saved.map((row) => row['rule_key'])).toEqual([...SIGNAL_RULE_KEYS].sort());
    const byRule = new Map(saved.map((row) => [row['rule_key'], row]));
    expect(byRule.get('stale_task')).toMatchObject({ enabled: 1, threshold: 21 });
    expect(byRule.get('overdue_invoice')).toMatchObject({ enabled: 0, threshold: 7 });
  });
});

describe('62-27 money stays with finance', () => {
  afterEach(async () => {
    await removeFixtures();
    await resetSignals();
  });

  it('an overdue-invoice notice reaches finance.view holders only; a task notice its assignee', async () => {
    await resetSignals();
    const stale = await staleItem(atlasProject(), 'Waiting on copy', world.northstar.designer.id);
    const overdue = await invoice({
      projectId: atlasProject(),
      number: 'T1-0100',
      dueDate: '2026-05-20',
    });
    await sweep(NOW);
    await deliverNotices();

    const [invoiceSignal] = await signalsOf('overdue_invoice', overdue);
    const [staleSignal] = await signalsOf('stale_task', stale);
    // Finance team = the owner and the Atlas manager. Not the designer (no finance.view), not
    // Sara or Adil (their role holds it, a live per-member override takes it away).
    expect(await noticeRecipients(invoiceSignal!.id)).toEqual(
      sorted(world.northstar.owner.id, world.northstar.manager.id),
    );
    expect(await noticeRecipients(staleSignal!.id)).toEqual([world.northstar.designer.id]);
  });

  it('an owner without finance.view is shown no money rule and cannot save one', async () => {
    const owner = world.northstar.owner;
    const full = await viewer(owner.id);
    expect((await settings.read(full.context, full.principal)).rules).toHaveLength(8);

    const override = await denyFinance(owner.membershipId, owner.id);
    try {
      const narrowed = await viewer(owner.id);
      const listedRules = (await settings.read(narrowed.context, narrowed.principal)).rules;
      expect(listedRules.map((rule) => rule.rule)).toEqual(
        SIGNAL_RULE_KEYS.filter((rule) => !SIGNAL_RULES[rule].money),
      );
      await expect(
        settings.update(
          narrowed.context,
          narrowed.principal,
          settingsBody({}, ['overdue_invoice']),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(await rows('select id from work_signal_settings')).toEqual([]);
    } finally {
      await db.admin.execute('delete from membership_permission_overrides where id = ?', [
        override,
      ]);
    }
  });
});

describe('62-A1b / 62-A1c the briefing of one swept company', () => {
  // Signals the sweep at NOW files, and who may see each.
  let atlasStale: string; // Atlas: Sara and Omar lead it
  let brandStale: string; // Brand Refresh: Omar leads it
  let sideStale: string; // Side project: nobody leads it
  let deletedStale: string; // deleted after the sweep
  let archivedStale: string; // its project is archived after the sweep
  let atlasInvoice: string; // money
  let twinStale: string; // the twin company

  beforeAll(async () => {
    await resetSignals();
    const side = await project('Side project');
    const old = await project('Old project');
    await joinProject(side, tariq.id);
    await joinProject(side, huda.id);
    await joinProject(old, sara.id);

    atlasStale = await staleItem(atlasProject(), 'Waiting on copy', world.northstar.designer.id);
    brandStale = await staleItem(brandProject(), 'Brand palette');
    sideStale = await staleItem(side, 'Side errand');
    deletedStale = await staleItem(atlasProject(), 'Removed later');
    archivedStale = await staleItem(old, 'Old errand');
    atlasInvoice = await invoice({
      projectId: atlasProject(),
      number: 'T1-0200',
      dueDate: '2026-05-20',
    });
    // Overloaded: Lina (on Atlas), Tariq (side only), Huda (side only, reports to Sara).
    for (const someone of [world.northstar.designer, tariq, huda]) {
      await capacity(someone.membershipId, 10);
    }
    await plannedWork(atlasProject(), world.northstar.designer.id, 700);
    await plannedWork(side, tariq.id, 700);
    await plannedWork(side, huda.id, 700);

    await setFlag(world.twin.organizationId, true);
    await setFlag(world.brightops.organizationId, true);
    twinStale = await insert('work_items', {
      organization_id: world.twin.organizationId,
      project_id: world.twin.projectId,
      title: 'Waiting on copy',
      state: 'in_progress',
      created_at: at(-60 * DAY),
      updated_at: at(-20 * DAY),
    });

    await sweep(NOW);

    await db.admin.execute('update work_items set deleted_at = ?, updated_at = ? where id = ?', [
      at(MINUTE),
      at(MINUTE),
      deletedStale,
    ]);
    await db.admin.execute('update projects set archived_at = ? where id = ?', [at(MINUTE), old]);
  });

  afterAll(async () => {
    await setFlag(world.twin.organizationId, false);
    await setFlag(world.brightops.organizationId, false);
    await removeFixtures();
    await resetSignals();
  });

  describe('Home: who sees what (GET home/briefing through the real service)', () => {
    it('the owner sees the whole company, money included; nothing deleted, archived or twin', async () => {
      const view = await briefingOf(world.northstar.owner.id);
      expect(view.audience).toBe('company');
      expect(view.asOf).toBe(NOW.toISOString());
      expect(listed(view)).toEqual({
        money_to_collect: { count: 1, subjects: [atlasInvoice] },
        people_overloaded: {
          count: 3,
          subjects: sorted(
            world.northstar.designer.membershipId,
            tariq.membershipId,
            huda.membershipId,
          ),
        },
        stale_work: { count: 3, subjects: sorted(atlasStale, brandStale, sideStale) },
      });
      const all = view.groups.flatMap((group) => group.lines.map((line) => line.subjectId));
      expect(all).not.toContain(deletedStale);
      expect(all).not.toContain(archivedStale);
      expect(all).not.toContain(twinStale);
    });

    it('an org admin without finance.view sees the company without the money groups', async () => {
      const view = await briefingOf(adil.id);
      expect(view.audience).toBe('company');
      expect(Object.keys(listed(view)).sort()).toEqual(['people_overloaded', 'stale_work']);
    });

    it('a lead sees only the projects they lead and their team, without money', async () => {
      const view = await briefingOf(sara.id);
      expect(view.audience).toBe('team');
      expect(listed(view)).toEqual({
        people_overloaded: {
          count: 2,
          subjects: sorted(world.northstar.designer.membershipId, huda.membershipId),
        },
        stale_work: { count: 1, subjects: [atlasStale] },
      });
    });

    it('a lead holding finance.view also sees the money of the projects they lead', async () => {
      const view = await briefingOf(world.northstar.manager.id);
      expect(view.audience).toBe('team');
      expect(listed(view)).toEqual({
        money_to_collect: { count: 1, subjects: [atlasInvoice] },
        people_overloaded: { count: 1, subjects: [world.northstar.designer.membershipId] },
        stale_work: { count: 2, subjects: sorted(atlasStale, brandStale) },
      });
    });

    it('a plain member has no briefing', async () => {
      expect(await briefingOf(world.northstar.designer.id)).toEqual({
        audience: 'none',
        asOf: null,
        groups: [],
      });
    });

    it('a client and an internal guest get the calm 404', async () => {
      await expect(briefingOf(world.atlas.reviewer.id)).rejects.toMatchObject({ status: 404 });
      await expect(briefingOf(gus.id)).rejects.toMatchObject({ status: 404 });
    });

    it('the twin company sees only its own signal', async () => {
      const view = await briefingOf(world.twin.owner.id, world.twin.organizationId);
      expect(listed(view)).toEqual({ stale_work: { count: 1, subjects: [twinStale] } });
    });
  });

  describe('the digest mail section (worker digest store)', () => {
    async function recipient(
      membershipId: string,
      briefingSwitch: boolean,
    ): Promise<DigestRecipient> {
      const organizationId = (
        await rows('select organization_id from memberships where id = ?', [membershipId])
      )[0]!['organization_id'] as string;
      await insert('pref_digest', {
        organization_id: organizationId,
        membership_id: membershipId,
        digest_json: JSON.stringify({
          cadence: 'daily',
          sendHour: 8,
          dayOfWeek: 0,
          businessBriefing: briefingSwitch,
        }),
      });
      const found = (await digests.listRecipients(5_000)).find(
        (candidate) => candidate.membershipId === membershipId,
      );
      expect(found?.businessBriefing).toBe(briefingSwitch);
      return found!;
    }

    const windowAt = () => ({
      since: at(-DAY),
      key: `digest:t1:${uuidv7()}`,
      cadence: 'daily' as const,
      at: NOW,
    });
    const link = (path: string) => `https://app.example${path}`;
    const withoutLinks = (groups: readonly (BriefingGroup & { link: string })[]) =>
      groups.map(({ link: _link, ...group }) => group);

    async function claims(userId: string): Promise<number> {
      return (
        await rows('select id from notifications where recipient_user_id = ? and type = ?', [
          userId,
          DIGEST_SENT,
        ])
      ).length;
    }

    beforeEach(async () => {
      await db.admin.execute('delete from notifications');
    });

    it.each([
      ['the owner', (): Person => world.northstar.owner],
      ['a lead without finance', (): Person => sara],
    ])('the section equals the Home briefing for %s', async (_who, who) => {
      const someone = who();
      const facts = await digests.collectAndClaim(
        await recipient(someone.membershipId, true),
        windowAt(),
        link,
      );
      const home = await briefingOf(someone.id);

      expect(facts?.briefing).toBeDefined();
      expect(facts!.briefing!.audience).toBe(home.audience);
      expect(facts!.briefing!.asOf.toISOString()).toBe(home.asOf);
      expect(withoutLinks(facts!.briefing!.groups)).toEqual(home.groups);
      expect(await claims(someone.id)).toBe(1);
    });

    it('a member with no briefing and nothing unread is not mailed and claims nothing', async () => {
      const designer = world.northstar.designer;
      expect(
        await digests.collectAndClaim(
          await recipient(designer.membershipId, true),
          windowAt(),
          link,
        ),
      ).toBeNull();
      expect(await claims(designer.id)).toBe(0);
    });

    it('a finished sweep that found nothing, and nothing unread, claims nothing', async () => {
      // Brightops was swept at NOW (its flag is on) and nothing there needs anyone.
      expect(await sweptAt(world.brightops.organizationId)).toEqual(NOW);
      const owner = world.brightops.owner;
      expect(
        await digests.collectAndClaim(await recipient(owner.membershipId, true), windowAt(), link),
      ).toBeNull();
      expect(await claims(owner.id)).toBe(0);
    });
  });
});
