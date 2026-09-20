import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsService } from './work-items.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { PredecessorHealthRow, WorkGraphRepository } from './work-graph.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkBlockerRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * UNIT-12's project subject: `projectHealthOf` rolls per-item health up across a project,
 * re-using the same rule `healthOf` applies to one item. Database-free proofs over the
 * module's fakes; the per-item rule is already DB-proven, so the roll-up needs no `.db.test.ts`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

/** Only the fields the roll-up reads (id, tenancy/audience for `mayRead`, soft-delete). */
function item(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    audience: 'internal',
    state: 'in_progress',
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function latePredecessor(): PredecessorHealthRow {
  return {
    dependencyId: 'dep-1',
    workItemId: 'work-pred-000000000-0000-000000000099',
    projectId: PROJECT,
    audience: 'internal',
    title: 'an upstream task',
    state: 'in_progress',
    dueAt: YESTERDAY,
    deletedAt: null,
  };
}

function activeBlocker(): WorkBlockerRow {
  return {
    id: 'blocker-0000-0000-0000-000000000001',
    ask: 'unblock me',
    ownerUserId: null,
    createdAt: new Date(),
  } as unknown as WorkBlockerRow;
}

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

/**
 * The fake `list` mirrors the real query's `projectId`/soft-delete/keyset predicates but not the
 * tenant scope, so a cross-tenant row reaches the service and the roll-up must drop it through
 * its own `mayRead` — belt-and-braces to the tenant-scoped SQL, exactly as `list` does per row.
 */
function serviceWith(
  rows: readonly WorkItemRow[],
  blockers: Readonly<Record<string, WorkBlockerRow | null>> = {},
  predecessors: Readonly<Record<string, readonly PredecessorHealthRow[]>> = {},
): WorkItemsService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = {
    list: async (
      _runner: unknown,
      _context: unknown,
      options: { readonly projectId?: string; readonly after?: string },
    ) =>
      rows.filter(
        (row) =>
          (options.projectId === undefined || row.projectId === options.projectId) &&
          row.deletedAt === null &&
          (options.after === undefined || row.id > options.after),
      ),
  } as unknown as WorkItemsRepository;
  const graph = {
    findActiveBlocker: async (_runner: unknown, _context: unknown, id: string) =>
      blockers[id] ?? null,
    listPredecessors: async (_runner: unknown, _context: unknown, id: string) =>
      predecessors[id] ?? [],
  } as unknown as WorkGraphRepository;
  return new WorkItemsService(database, workItems, undefined, undefined, undefined, graph);
}

const context = { organizationId: ORG } as unknown as TenantContext;

describe('projectHealthOf roll-up', () => {
  it('counts a mix of item states and derives the project state, excluding a cross-tenant item', async () => {
    const onTrack = item({ id: 'work-a-0000000000-0000-000000000001' });
    const atRisk = item({ id: 'work-b-0000000000-0000-000000000002' });
    const blocked = item({ id: 'work-c-0000000000-0000-000000000003' });
    const foreign = item({
      id: 'work-z-0000000000-0000-000000000009',
      organizationId: OTHER_ORG,
    });

    const service = serviceWith(
      [onTrack, atRisk, blocked, foreign],
      { [blocked.id]: activeBlocker() },
      { [atRisk.id]: [latePredecessor()] },
    );

    const health = await service.projectHealthOf(context, member([PROJECT]), PROJECT);

    expect(health.projectId).toBe(PROJECT);
    expect(health.counts).toEqual({ on_track: 1, at_risk: 1, blocked: 1 });
    expect(health.itemCount).toBe(3);
    // Blocked outranks at-risk outranks on-track, the per-item precedence lifted to the project.
    expect(health.status).toBe('blocked');
    expect(typeof health.computedAt).toBe('string');
    // The other tenant's row never contributes.
    expect(JSON.stringify(health)).not.toContain(OTHER_ORG);
  });

  it('rolls an empty project up to zero counts and on_track', async () => {
    const service = serviceWith([]);

    const health = await service.projectHealthOf(context, member([PROJECT]), PROJECT);

    expect(health.counts).toEqual({ on_track: 0, at_risk: 0, blocked: 0 });
    expect(health.itemCount).toBe(0);
    expect(health.status).toBe('on_track');
  });
});
