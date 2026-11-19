import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { auditObjectTypeFor, capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { AuditAction, Principal, Role } from '@tmanage/domain';
import { createWorkerDatabase } from '@tmanage/worker';
import type { WorkerDatabase } from '@tmanage/worker';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { StubScanner } from '../src/common/scan/malware-scanner.js';
import { ActivityService } from '../src/modules/activity/activity.service.js';
import type { AuditService } from '../src/modules/audit/audit.service.js';
import { ClientSummaryService } from '../src/modules/clients/client-summary.service.js';
import { ClientsService } from '../src/modules/clients/clients.service.js';
import { OutboxEventsRepository } from '../src/modules/platform/outbox-events.repository.js';
import { ProjectSummaryService } from '../src/modules/projects/project-summary.service.js';
import { ProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { ProjectsService } from '../src/modules/projects/projects.service.js';
import { buildSummarySources } from '../src/modules/projects/summary-sources.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T1 2026-11-19 (lane A) — the activity history (B02, migration 0379) and the one-page project and
 * client summaries (B01 / B10) on the real engine (MariaDB 11.8), through the worker's real
 * projector store and the API services built as their modules wire them.
 *
 * - Activity projector: a back-fill over real `audit_events` files the catalogued, allowed events
 *   under their project and client; a second run, and a run from a reset cursor, write no
 *   duplicate (`source_audit_id` unique, `INSERT IGNORE`).
 * - Activity read: parent first (a project the caller may not read, or another tenant's, is a 404);
 *   per-entry re-check (deleted source dropped, finance entries need `finance.view`); the client
 *   feed spans the client's shared projects only.
 * - Summaries: the capability matrix on real rows, finance blocks absent with the flag off, figures
 *   equal to the seeded rows, two-workspace isolation, member without the project and client
 *   principal = 404. The BOLA corpus rows for both routes are run by sec-001, not here.
 *
 * Not covered here: the worker / app grants of 0379 (the local DB suite runs as admin; the
 * least-privilege proof needs a provisioned server).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const workerModule = async <T>(path: string): Promise<T> =>
  (await import(pathToFileURL(resolve(HERE, '../../worker/src', path)).href)) as T;

interface ProjectorStoreModule {
  createActivityProjectorStore(database: WorkerDatabase): unknown;
}
interface ProjectorModule {
  runActivityProjection(deps: {
    store: unknown;
    now: Date;
  }): Promise<{ organizations: number; events: number; filed: number }>;
}

/** Every audit row is dated hours before the projector's clock: well past the settle lag. */
const EVENTS_FROM = new Date('2026-11-19T06:00:00.000Z');
const NOW = new Date('2026-11-19T12:00:00.000Z');

const fakeAudit = { record: vi.fn(() => Promise.resolve({})) } as unknown as AuditService;

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let workerDb: WorkerDatabase;

async function rows(sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await db.admin.query<RowDataPacket[]>(sql, params);
  return result;
}

interface Caller {
  readonly context: TenantContext;
  readonly principal: Principal;
}

/** A caller as the session resolver would build it: context + principal from the seeded rows. */
function caller(
  organizationId: string,
  user: { id: string; membershipId: string },
  role: Role,
  options: {
    projectIds?: readonly string[];
    orgWide?: boolean;
    clientOrganizationId?: string;
  } = {},
): Caller {
  const kind = options.clientOrganizationId === undefined ? 'internal' : 'client';
  return {
    context: createTenantContext({
      organizationId,
      userId: user.id,
      membershipId: user.membershipId,
      principalKind: kind,
      capabilities: capabilitiesFor(role),
      policyVersion: 't1-1119',
      correlationId: uuidv7(),
    }),
    principal: {
      userId: user.id,
      organizationId,
      kind,
      role,
      membershipId: user.membershipId,
      membershipStatus: 'active',
      clientOrganizationId: options.clientOrganizationId ?? null,
      projectIds: options.projectIds ?? [],
      hasOrgWideScope: options.orgWide ?? false,
    },
  };
}

/** The HTTP status a call is refused with (`null` when it succeeds). */
async function refusal(call: () => Promise<unknown>): Promise<number | null> {
  try {
    await call();
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
}

let auditSeq = 0;
/** One `audit_events` row, dated a second after the previous one. */
async function auditEvent(
  organizationId: string,
  action: AuditAction,
  objectId: string,
  actorUserId: string,
  result: 'allowed' | 'denied' = 'allowed',
): Promise<string> {
  const id = uuidv7();
  auditSeq += 1;
  await db.admin.query(
    `insert into audit_events
       (id, organization_id, actor_user_id, effective_actor_id, action, object_type, object_id,
        result, correlation_id, metadata_json, created_at, ip, user_agent)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '198.51.100.7', 'Chrome/130')`,
    [
      id,
      organizationId,
      actorUserId,
      actorUserId,
      action,
      auditObjectTypeFor(action),
      objectId,
      result,
      uuidv7(),
      new Date(EVENTS_FROM.getTime() + auditSeq * 1000),
    ],
  );
  return id;
}

async function workItem(
  organizationId: string,
  projectId: string,
  state: 'in_progress' | 'done',
  dueAt: Date | null = null,
): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    `insert into work_items (id, organization_id, project_id, title, state, due_at)
     values (?, ?, ?, 'Prepare mobile booking flow concepts', ?, ?)`,
    [id, organizationId, projectId, state, dueAt],
  );
  return id;
}

/** A ready, clean, promoted file on TManage's own storage, updated at `at`. */
async function cleanFile(
  organizationId: string,
  projectId: string,
  ownerUserId: string,
  at: Date,
): Promise<string> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  await db.admin.query(
    `insert into file_assets
       (id, organization_id, project_id, owner_user_id, name, purpose, object_id, audience, status,
        version, created_at, updated_at)
     values (?, ?, ?, ?, 'brief.pdf', 'deliverable', ?, 'internal', 'ready', 1, ?, ?)`,
    [assetId, organizationId, projectId, ownerUserId, uuidv7(), at, at],
  );
  await db.admin.query(
    `insert into file_versions
       (id, organization_id, file_asset_id, version_no, object_key, size_bytes, declared_mime_type,
        detected_mime_type)
     values (?, ?, ?, 1, ?, 2048, 'application/pdf', 'application/pdf')`,
    [versionId, organizationId, assetId, `tenant/${organizationId}/${versionId}`],
  );
  // Born in quarantine; promoted by the scan, as the pipeline does.
  await db.admin.query(
    `update file_versions set trust_zone = 'private', scan_verdict = 'clean', scanned_at = ?,
       scanner = 'test', content_hash = ? where id = ?`,
    [at, createHash('sha256').update(versionId).digest('hex'), versionId],
  );
  return assetId;
}

async function expense(organizationId: string, projectId: string, membershipId: string) {
  const id = uuidv7();
  await db.admin.query(
    `insert into expenses
       (id, organization_id, project_id, membership_id, spent_on, category, amount_minor, currency,
        state, created_at, updated_at)
     values (?, ?, ?, ?, '2026-11-01', 'Ads', 5000, 'SAR', 'approved', ?, ?)`,
    [id, organizationId, projectId, membershipId, EVENTS_FROM, EVENTS_FROM],
  );
  return id;
}

async function clientOrganization(organizationId: string, projectId: string): Promise<string> {
  const id = uuidv7();
  await db.admin.query(
    'insert into client_organizations (id, organization_id, name) values (?, ?, ?)',
    [id, organizationId, 'Atlas Hospitality'],
  );
  await db.admin.query(
    `insert into project_clients (id, organization_id, project_id, client_organization_id)
     values (?, ?, ?, ?)`,
    [uuidv7(), organizationId, projectId, id],
  );
  return id;
}

async function invoice(
  organizationId: string,
  clientOrganizationId: string,
  createdBy: string,
  figures: { state: string; totalMinor: number; paidMinor: number; dueDate: string | null },
): Promise<void> {
  await db.admin.query(
    `insert into client_invoices
       (id, organization_id, client_organization_id, state, issue_date, due_date, currency,
        base_currency, subtotal_minor, total_minor, paid_minor, created_by, created_at, updated_at)
     values (?, ?, ?, ?, '2026-10-01', ?, 'SAR', 'SAR', ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(),
      organizationId,
      clientOrganizationId,
      figures.state,
      figures.dueDate,
      figures.totalMinor,
      figures.totalMinor,
      figures.paidMinor,
      createdBy,
      EVENTS_FROM,
      EVENTS_FROM,
    ],
  );
}

beforeAll(async () => {
  db = await startTestDatabase();
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  workerDb = createWorkerDatabase({
    url: db.workerUrl,
    connectionLimit: 3,
    statementTimeoutMs: 15_000,
  });
  world = await seedTwoTenants(db.admin);
});

afterAll(async () => {
  await workerDb?.end();
  await db?.stop();
});

describe('activity history (B02, 0379): projector over audit_events, then the Activity read', () => {
  const activity = () => new ActivityService(tenant);
  let project: () => ReturnType<ProjectorModule['runActivityProjection']>;

  /** The audit-sourced object ids of a page, in the page's order. */
  const objectIds = (page: { entries: readonly { objectId: string }[] }) =>
    page.entries.map((entry) => entry.objectId);

  // The back-filled world: ids of the source rows each catalogued event is about.
  let taskOnProject: string;
  let taskOnOtherProject: string;
  let fileOnProject: string;
  let expenseOnProject: string;
  let taskOnMeridian: string;
  let taskOnTwin: string;
  let deniedEvent: string;

  const owner = () =>
    caller(world.northstar.organizationId, world.northstar.owner, 'owner', { orgWide: true });
  const designer = () =>
    caller(world.northstar.organizationId, world.northstar.designer, 'member', {
      projectIds: [world.northstar.projectId],
    });
  const twinOwner = () =>
    caller(world.twin.organizationId, world.twin.owner, 'owner', {
      orgWide: true,
      projectIds: [world.twin.projectId],
    });

  beforeAll(async () => {
    const north = world.northstar;
    taskOnProject = north.workItemId;
    taskOnOtherProject = await workItem(north.organizationId, north.otherProjectId, 'in_progress');
    fileOnProject = await cleanFile(north.organizationId, north.projectId, north.owner.id, NOW);
    expenseOnProject = await expense(
      north.organizationId,
      north.projectId,
      north.owner.membershipId,
    );
    taskOnMeridian = await workItem(north.organizationId, world.meridian.projectId, 'in_progress');
    taskOnTwin = world.twin.workItemId;

    await auditEvent(north.organizationId, 'work_item.created', taskOnProject, north.owner.id);
    await auditEvent(
      north.organizationId,
      'work_item.transitioned',
      taskOnProject,
      north.designer.id,
    );
    await auditEvent(north.organizationId, 'work_item.created', taskOnOtherProject, north.owner.id);
    await auditEvent(north.organizationId, 'file_asset.uploaded', fileOnProject, north.owner.id);
    await auditEvent(north.organizationId, 'expense.created', expenseOnProject, north.owner.id);
    // A money action on a non-money source (the project): only the finance flag hides it.
    await auditEvent(north.organizationId, 'budget.updated', north.projectId, north.owner.id);
    await auditEvent(north.organizationId, 'work_item.created', taskOnMeridian, north.manager.id);
    deniedEvent = await auditEvent(
      north.organizationId,
      'work_item.updated',
      taskOnProject,
      north.designer.id,
      'denied',
    );
    await auditEvent(
      world.twin.organizationId,
      'work_item.created',
      taskOnTwin,
      world.twin.owner.id,
    );

    const { createActivityProjectorStore } = await workerModule<ProjectorStoreModule>(
      'common/database/activity-projector-store.ts',
    );
    const { runActivityProjection } = await workerModule<ProjectorModule>(
      'jobs/activity-projector.ts',
    );
    const store = createActivityProjectorStore(workerDb);
    project = () => runActivityProjection({ store, now: NOW });
  });

  describe('the projector', () => {
    it('back-fills one entry per catalogued, allowed event, filed under its project and client', async () => {
      await project();
      const entries = await rows(
        `select organization_id, project_id, object_id, action, audience_class, source_audit_id
           from activity_entries order by occurred_at, id`,
      );
      const north = world.northstar;
      expect(
        entries.map((row) => [row['organization_id'], row['project_id'], row['action']]),
      ).toEqual([
        [north.organizationId, north.projectId, 'work_item.created'],
        [north.organizationId, north.projectId, 'work_item.transitioned'],
        [north.organizationId, north.otherProjectId, 'work_item.created'],
        [north.organizationId, north.projectId, 'file_asset.uploaded'],
        [north.organizationId, north.projectId, 'expense.created'],
        [north.organizationId, north.projectId, 'budget.updated'],
        [north.organizationId, world.meridian.projectId, 'work_item.created'],
        [world.twin.organizationId, world.twin.projectId, 'work_item.created'],
      ]);
      const money = entries.filter((row) => row['audience_class'] === 'finance');
      expect(money.map((row) => row['action'])).toEqual(['expense.created', 'budget.updated']);
      expect(entries.map((row) => row['source_audit_id'])).not.toContain(deniedEvent);
    });

    it('writes no duplicate on a second run, nor on a run from a reset cursor', async () => {
      const before = await rows('select count(*) as n from activity_entries');
      expect((await project()).filed).toBe(0);
      await db.admin.query('delete from activity_projection_cursors');
      const again = await project();
      expect(again.events).toBeGreaterThan(0);
      expect(again.filed).toBe(0);
      const after = await rows(
        `select count(*) as n, count(distinct source_audit_id) as sources from activity_entries`,
      );
      expect(Number(after[0]?.['n'])).toBe(Number(before[0]?.['n']));
      expect(Number(after[0]?.['sources'])).toBe(Number(after[0]?.['n']));
    });
  });

  describe('the project feed', () => {
    it('lists the project’s entries newest first for the owner, money included', async () => {
      const { context, principal } = owner();
      const page = await activity().projectActivity(context, principal, world.northstar.projectId);
      expect(objectIds(page)).toEqual([
        world.northstar.projectId,
        expenseOnProject,
        fileOnProject,
        taskOnProject,
        taskOnProject,
      ]);
      expect(page.entries[0]?.action).toBe('budget.updated');
      expect(page.nextCursor).toBeNull();
    });

    it('hides a finance entry from a member without finance.view', async () => {
      const { context, principal } = designer();
      const page = await activity().projectActivity(context, principal, world.northstar.projectId);
      expect(objectIds(page)).toEqual([fileOnProject, taskOnProject, taskOnProject]);
    });

    it('answers 404 to a member who is not on the project', async () => {
      const { context, principal } = designer();
      const status = await refusal(() =>
        activity().projectActivity(context, principal, world.northstar.otherProjectId),
      );
      expect(status).toBe(404);
      // The owner does read that project's entry, so the 404 is the member's, not an empty feed.
      const owned = owner();
      const page = await activity().projectActivity(
        owned.context,
        owned.principal,
        world.northstar.otherProjectId,
      );
      expect(objectIds(page)).toEqual([taskOnOtherProject]);
    });

    it('drops the entry of a source that has been deleted', async () => {
      const { context, principal } = owner();
      await db.admin.query('update file_assets set deleted_at = ? where id = ?', [
        NOW,
        fileOnProject,
      ]);
      try {
        const page = await activity().projectActivity(
          context,
          principal,
          world.northstar.projectId,
        );
        expect(objectIds(page)).toEqual([
          world.northstar.projectId,
          expenseOnProject,
          taskOnProject,
          taskOnProject,
        ]);
      } finally {
        await db.admin.query('update file_assets set deleted_at = null where id = ?', [
          fileOnProject,
        ]);
      }
    });

    it('keeps two workspaces apart: each sees its own entries, the other’s project is a 404', async () => {
      const twin = twinOwner();
      const own = await activity().projectActivity(
        twin.context,
        twin.principal,
        world.twin.projectId,
      );
      expect(objectIds(own)).toEqual([taskOnTwin]);
      expect(
        await refusal(() =>
          activity().projectActivity(twin.context, twin.principal, world.northstar.projectId),
        ),
      ).toBe(404);
      const north = owner();
      expect(
        await refusal(() =>
          activity().projectActivity(north.context, north.principal, world.twin.projectId),
        ),
      ).toBe(404);
    });
  });

  describe('the client feed', () => {
    it('spans only the projects shared with that client', async () => {
      const { context, principal } = owner();
      const atlas = await activity().clientActivity(
        context,
        principal,
        world.atlas.clientOrganizationId,
      );
      expect(objectIds(atlas)).toEqual([
        world.northstar.projectId,
        expenseOnProject,
        fileOnProject,
        taskOnProject,
        taskOnProject,
      ]);
      const meridian = await activity().clientActivity(
        context,
        principal,
        world.meridian.clientOrganizationId,
      );
      expect(objectIds(meridian)).toEqual([taskOnMeridian]);
    });

    it('is a 404 without org.manage, and for another workspace’s client', async () => {
      const member = designer();
      expect(
        await refusal(() =>
          activity().clientActivity(
            member.context,
            member.principal,
            world.atlas.clientOrganizationId,
          ),
        ),
      ).toBe(404);
      const twin = twinOwner();
      expect(
        await refusal(() =>
          activity().clientActivity(twin.context, twin.principal, world.atlas.clientOrganizationId),
        ),
      ).toBe(404);
    });
  });
});

describe('one-page summaries (B01 / B10): project and client pages on real rows', () => {
  const projectSummary = () =>
    new ProjectSummaryService(
      new ProjectsService(tenant, new ProjectsRepository(), fakeAudit),
      buildSummarySources({
        database: tenant,
        audit: fakeAudit,
        outbox: new OutboxEventsRepository(),
        scanner: new StubScanner(),
      }),
      () => NOW,
    );
  const clientSummary = () =>
    new ClientSummaryService(
      new ClientsService(
        tenant,
        { defaultExpiryDays: 90 },
        undefined,
        undefined,
        undefined,
        undefined,
        fakeAudit,
      ),
      buildSummarySources({
        database: tenant,
        audit: fakeAudit,
        outbox: new OutboxEventsRepository(),
        scanner: new StubScanner(),
      }),
      () => NOW,
    );

  /** A project of its own, so the activity cases' rows do not move these figures. */
  let summaryProjectId: string;
  let summaryClientId: string;
  let twinClientId: string;
  let files: string[];

  const owner = () =>
    caller(world.northstar.organizationId, world.northstar.owner, 'owner', { orgWide: true });
  const manager = () =>
    caller(world.northstar.organizationId, world.northstar.manager, 'manager', {
      projectIds: [summaryProjectId],
    });
  const member = () =>
    caller(world.northstar.organizationId, world.northstar.designer, 'member', {
      projectIds: [summaryProjectId],
    });
  const twinOwner = () =>
    caller(world.twin.organizationId, world.twin.owner, 'owner', {
      orgWide: true,
      projectIds: [world.twin.projectId],
    });

  beforeAll(async () => {
    const north = world.northstar;
    summaryProjectId = uuidv7();
    await db.admin.query(
      'insert into projects (id, organization_id, workspace_id, name) values (?, ?, ?, ?)',
      [summaryProjectId, north.organizationId, north.workspaceId, 'Atlas Website Relaunch'],
    );
    for (const user of [north.manager, north.designer]) {
      await db.admin.query(
        `insert into project_memberships (id, organization_id, project_id, user_id)
         values (?, ?, ?, ?)`,
        [uuidv7(), north.organizationId, summaryProjectId, user.id],
      );
    }
    // Delivery: two open (one of them late), one done.
    await workItem(north.organizationId, summaryProjectId, 'in_progress');
    await workItem(
      north.organizationId,
      summaryProjectId,
      'in_progress',
      new Date('2026-11-01T00:00:00Z'),
    );
    await workItem(north.organizationId, summaryProjectId, 'done');
    files = [
      await cleanFile(
        north.organizationId,
        summaryProjectId,
        north.owner.id,
        new Date('2026-11-10T00:00:00Z'),
      ),
      await cleanFile(
        north.organizationId,
        summaryProjectId,
        north.owner.id,
        new Date('2026-11-12T00:00:00Z'),
      ),
    ];
    summaryClientId = await clientOrganization(north.organizationId, summaryProjectId);
    await invoice(north.organizationId, summaryClientId, north.owner.id, {
      state: 'sent',
      totalMinor: 10_000,
      paidMinor: 2_500,
      dueDate: '2026-10-15',
    });
    await invoice(north.organizationId, summaryClientId, north.owner.id, {
      state: 'paid',
      totalMinor: 5_000,
      paidMinor: 5_000,
      dueDate: '2026-10-15',
    });
    await invoice(north.organizationId, summaryClientId, north.owner.id, {
      state: 'draft',
      totalMinor: 99_000,
      paidMinor: 0,
      dueDate: null,
    });

    // The twin: the same names, more of everything — any leak moves Northstar's figures.
    const twin = world.twin;
    for (let i = 0; i < 3; i += 1) await workItem(twin.organizationId, twin.projectId, 'done');
    await cleanFile(
      twin.organizationId,
      twin.projectId,
      twin.owner.id,
      new Date('2026-11-18T00:00:00Z'),
    );
    twinClientId = await clientOrganization(twin.organizationId, twin.projectId);
    await invoice(twin.organizationId, twinClientId, twin.owner.id, {
      state: 'sent',
      totalMinor: 70_000,
      paidMinor: 0,
      dueDate: '2026-10-15',
    });
  });

  describe('capability matrix', () => {
    const ALL = [
      'approvals',
      'budget',
      'delivery',
      'files',
      'health',
      'milestone',
      'money',
      'project',
      'time',
    ];

    it('gives the owner and the project manager every block', async () => {
      for (const { context, principal } of [owner(), manager()]) {
        const view = await projectSummary().get(context, principal, summaryProjectId);
        expect(Object.keys(view).sort()).toEqual(ALL);
      }
    });

    it('gives a member no budget, milestone or money block', async () => {
      const { context, principal } = member();
      const view = await projectSummary().get(context, principal, summaryProjectId);
      expect(Object.keys(view).sort()).toEqual([
        'approvals',
        'delivery',
        'files',
        'health',
        'project',
        'time',
      ]);
    });

    it('leaves the finance blocks out while their flags are off', async () => {
      const org = world.northstar.organizationId;
      for (const flag of ['finance_reports', 'client_invoicing']) {
        await db.admin.query(
          `insert into org_feature_flags (id, organization_id, flag_key, enabled, updated_at)
           values (?, ?, ?, 0, ?)`,
          [uuidv7(), org, flag, NOW],
        );
      }
      try {
        const { context, principal } = owner();
        const project = await projectSummary().get(context, principal, summaryProjectId);
        expect(project).not.toHaveProperty('money');
        expect(project).toHaveProperty('budget');
        const client = await clientSummary().get(context, principal, summaryClientId);
        expect(client).not.toHaveProperty('money');
        expect(client).not.toHaveProperty('unbilled');
        expect(client).toHaveProperty('delivery');
      } finally {
        await db.admin.query('delete from org_feature_flags where organization_id = ?', [org]);
      }
    });
  });

  describe('figures', () => {
    it('counts the project’s delivery and lists its files as seeded', async () => {
      const { context, principal } = owner();
      const view = await projectSummary().get(context, principal, summaryProjectId);
      expect(view.project.id).toBe(summaryProjectId);
      expect(view.delivery).toEqual({ open: 2, late: 1, done: 1, complete: true });
      expect(view.files?.items.map((file) => file.id)).toEqual([files[1], files[0]]);
    });

    it('sums the client’s projects and its sent invoices per currency', async () => {
      const { context, principal } = owner();
      const view = await clientSummary().get(context, principal, summaryClientId);
      expect(view.projects.items.map((project) => project.id)).toEqual([summaryProjectId]);
      expect(view.delivery).toEqual({ open: 2, late: 1, done: 1, complete: true });
      expect(view.files?.items).toHaveLength(2);
      expect(view.money).toEqual({
        totals: [
          {
            currency: 'SAR',
            invoicedMinor: 15_000,
            paidMinor: 7_500,
            dueMinor: 7_500,
            overdueMinor: 7_500,
            overdueCount: 1,
          },
        ],
        complete: true,
      });
    });
  });

  describe('who gets a 404', () => {
    it('another workspace: Northstar’s project and client are not found from the twin', async () => {
      const twin = twinOwner();
      expect(
        await refusal(() => projectSummary().get(twin.context, twin.principal, summaryProjectId)),
      ).toBe(404);
      expect(
        await refusal(() => clientSummary().get(twin.context, twin.principal, summaryClientId)),
      ).toBe(404);
      // And the twin's own page holds only the twin's rows.
      const own = await projectSummary().get(twin.context, twin.principal, world.twin.projectId);
      expect(own.delivery).toEqual({ open: 1, late: 0, done: 3, complete: true });
    });

    it('a member who is not on the project', async () => {
      const outsider = caller(world.northstar.organizationId, world.northstar.designer, 'member', {
        projectIds: [world.northstar.projectId],
      });
      expect(
        await refusal(() =>
          projectSummary().get(outsider.context, outsider.principal, summaryProjectId),
        ),
      ).toBe(404);
    });

    it('a client principal, even of the client the project is shared with', async () => {
      const client = caller(world.northstar.organizationId, world.atlas.admin, 'client_admin', {
        clientOrganizationId: summaryClientId,
        projectIds: [summaryProjectId],
      });
      // The client page first: its source answers a client with 403, so only the summary's own
      // staff-only rule makes this the 404 of a missing page.
      expect(
        await refusal(() => clientSummary().get(client.context, client.principal, summaryClientId)),
      ).toBe(404);
      expect(
        await refusal(() =>
          projectSummary().get(client.context, client.principal, summaryProjectId),
        ),
      ).toBe(404);
    });
  });
});
