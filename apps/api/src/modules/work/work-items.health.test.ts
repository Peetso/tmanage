import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsService } from './work-items.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { PredecessorHealthRow, WorkGraphRepository } from './work-graph.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

/**
 * R01 (12 September code review) / F3 (tenant-isolation audit): `healthOf` authorized the
 * dependent item and then disclosed each predecessor's title, id and due date without
 * authorizing the predecessor. A dependency can cross a project boundary — an org-wide admin
 * can link work across projects, and read access can be revoked after the edge is made — so a
 * member who can read the dependent item could learn the title and due date of work in a
 * project they cannot read.
 *
 * These are the fast, database-free proofs of the projection change: the redaction is decided
 * per caller, against each predecessor's own project and audience. The `.db.test.ts` case
 * proves the same against the real query and the real seed world.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const READABLE_PROJECT = 'project-readable-0000-0000-000000000001';
const SECRET_PROJECT = 'project-secret-00000-0000-000000000002';

/** A predecessor's identifying details, all of which a redacted signal must withhold. */
const SECRET_TITLE = 'CONFIDENTIAL OTHER PROJECT';
const SECRET_WORK_ITEM_ID = 'work-secret-00000000-0000-000000000009';
const SECRET_DUE_AT = new Date('2020-01-02T03:04:05.000Z');

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);
const ACCESSIBLE_TITLE = 'Deliver final photography';
const ACCESSIBLE_WORK_ITEM_ID = 'work-visible-0000000-0000-000000000008';

function successorRow(): WorkItemRow {
  const now = new Date();
  return {
    id: 'work-successor-00000-0000-000000000007',
    organizationId: ORG,
    projectId: READABLE_PROJECT,
    type: 'task',
    title: 'Assemble the brand book',
    state: 'in_progress',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
  };
}

function predecessor(overrides: Partial<PredecessorHealthRow>): PredecessorHealthRow {
  return {
    dependencyId: `dep-${overrides.workItemId ?? 'x'}`,
    workItemId: 'work-x',
    projectId: READABLE_PROJECT,
    audience: 'internal',
    title: 'a title',
    state: 'in_progress',
    dueAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** An internal principal scoped to exactly the projects listed, no org-wide reach. */
function member(projectIds: readonly string[]): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function serviceWith(predecessors: readonly PredecessorHealthRow[]): WorkItemsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = {
    findById: async () => successorRow(),
  } as unknown as WorkItemsRepository;
  const graph = {
    findActiveBlocker: async () => null,
    listPredecessors: async () => predecessors,
  } as unknown as WorkGraphRepository;
  return new WorkItemsService(database, workItems, undefined, undefined, undefined, graph);
}

const context = { organizationId: ORG } as unknown as TenantContext;
const SUCCESSOR = 'work-successor-00000-0000-000000000007';

describe('healthOf predecessor disclosure', () => {
  it('redacts a late predecessor the caller cannot read, and names an accessible one', async () => {
    const service = serviceWith([
      predecessor({
        workItemId: ACCESSIBLE_WORK_ITEM_ID,
        projectId: READABLE_PROJECT,
        title: ACCESSIBLE_TITLE,
        dueAt: YESTERDAY,
      }),
      predecessor({
        workItemId: SECRET_WORK_ITEM_ID,
        projectId: SECRET_PROJECT,
        title: SECRET_TITLE,
        dueAt: SECRET_DUE_AT,
      }),
    ]);

    const health = await service.healthOf(context, member([READABLE_PROJECT]), SUCCESSOR);

    expect(health.status).toBe('at_risk');
    const kinds = health.signals.map((signal) => signal.kind).sort();
    expect(kinds).toEqual(['predecessor_late', 'predecessor_redacted']);

    const late = health.signals.find((signal) => signal.kind === 'predecessor_late');
    expect(late).toEqual({
      kind: 'predecessor_late',
      workItemId: ACCESSIBLE_WORK_ITEM_ID,
      title: ACCESSIBLE_TITLE,
      dueAt: YESTERDAY.toISOString(),
    });

    // Nothing about the inaccessible predecessor survives into the response.
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(SECRET_TITLE);
    expect(serialized).not.toContain(SECRET_WORK_ITEM_ID);
    expect(serialized).not.toContain(SECRET_DUE_AT.toISOString());
  });

  it('redacts a blocked predecessor the caller cannot read', async () => {
    const service = serviceWith([
      predecessor({
        workItemId: SECRET_WORK_ITEM_ID,
        projectId: SECRET_PROJECT,
        title: SECRET_TITLE,
        state: 'blocked',
      }),
    ]);

    const health = await service.healthOf(context, member([READABLE_PROJECT]), SUCCESSOR);

    expect(health.status).toBe('at_risk');
    expect(health.signals).toEqual([{ kind: 'predecessor_redacted' }]);
    expect(JSON.stringify(health)).not.toContain(SECRET_TITLE);
  });

  it('discloses the full detail to an org-wide principal who may read the predecessor', async () => {
    const service = serviceWith([
      predecessor({
        workItemId: SECRET_WORK_ITEM_ID,
        projectId: SECRET_PROJECT,
        title: SECRET_TITLE,
        dueAt: SECRET_DUE_AT,
      }),
    ]);

    const orgWide: Principal = { ...member([]), role: 'owner', hasOrgWideScope: true };
    const health = await service.healthOf(context, orgWide, SUCCESSOR);

    expect(health.status).toBe('at_risk');
    expect(health.signals).toEqual([
      {
        kind: 'predecessor_late',
        workItemId: SECRET_WORK_ITEM_ID,
        title: SECRET_TITLE,
        dueAt: SECRET_DUE_AT.toISOString(),
      },
    ]);
  });
});
