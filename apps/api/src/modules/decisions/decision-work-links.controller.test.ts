import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { DecisionWorkLinksController } from './decision-work-links.controller.js';
import { DecisionWorkLinksService } from './decision-work-links.service.js';
import { DuplicateDecisionWorkLinkError } from './decision-work-links.repository.js';
import type {
  CreateDecisionWorkLinkInput,
  DecisionWorkLinkWithItem,
  DecisionWorkLinksRepository,
} from './decision-work-links.repository.js';
import type { DecisionsRepository } from './decisions.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  DecisionRow,
  DecisionWorkLinkRow,
  WorkItemRow,
} from '../../common/database/schema.js';

/**
 * DEC / module 12 (x149). The decision→work-links controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are the chain's DB suite;
 * here the subject is the controller + service logic:
 *
 * - the link → list → unlink round-trip;
 * - a duplicate pair is a 409 with no second row;
 * - the Known-trap — an unknown / cross-tenant `decisionId`, a work item in another project, and an
 *   unknown / cross-tenant `linkId` are each a 404 with no write, never a foreign-key 500;
 * - the relation gate (real authorize) — a member related to the decision's project may link; one who
 *   is not gets not-found, never a 403 that confirms it exists;
 * - the route ceilings the `CapabilityGuard` enforces — writes require `meeting.write`, the list
 *   requires `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const DECISION = 'decision-0000-0000-0000-000000000001';
const WORK_ITEM = 'work-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(
  role: Principal['role'],
  projectIds: readonly string[],
  orgWide = false,
): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', [], true);
const managerOnProject = principal('manager', [PROJECT]);
const managerElsewhere = principal('manager', []);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function decisionRow(id: string, organizationId = ORG, projectId = PROJECT): DecisionRow {
  return {
    id,
    organizationId,
    projectId,
    meetingId: null,
    title: 'Adopt the new intake flow',
    statement: 'We will move client intake to the new form.',
    status: 'accepted',
    decidedBy: USER,
    decidedAt: new Date(Date.UTC(2026, 0, 1)),
    createdAt: new Date(Date.UTC(2026, 0, 1)),
  } as DecisionRow;
}

function workItemRow(
  id: string,
  organizationId = ORG,
  projectId = PROJECT,
  deletedAt: Date | null = null,
): WorkItemRow {
  return {
    id,
    organizationId,
    projectId,
    type: 'task',
    title: 'Draft the brief',
    state: 'in_progress',
    ownerUserId: USER,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    deletedAt,
  } as WorkItemRow;
}

function build(options: {
  decisions?: readonly DecisionRow[];
  workItemsSeed?: readonly WorkItemRow[];
  linksSeed?: readonly DecisionWorkLinkRow[];
}): { controller: DecisionWorkLinksController; store: DecisionWorkLinkRow[] } {
  const decisionsStore = [...(options.decisions ?? [decisionRow(DECISION)])];
  const workItemsStore = [...(options.workItemsSeed ?? [workItemRow(WORK_ITEM)])];
  const store: DecisionWorkLinkRow[] = [...(options.linksSeed ?? [])];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const decisionsRepo = {
    findById: async (_runner: unknown, ctx: TenantContext, decisionId: string) =>
      decisionsStore.find(
        (row) => row.id === decisionId && row.organizationId === ctx.organizationId,
      ) ?? null,
  } as unknown as DecisionsRepository;

  const workItemsRepo = {
    findById: async (_runner: unknown, ctx: TenantContext, workItemId: string) =>
      workItemsStore.find(
        (row) => row.id === workItemId && row.organizationId === ctx.organizationId,
      ) ?? null,
  } as unknown as WorkItemsRepository;

  const linksRepo = {
    listByDecision: async (
      _runner: unknown,
      ctx: TenantContext,
      decisionId: string,
    ): Promise<readonly DecisionWorkLinkWithItem[]> =>
      store
        .filter((row) => row.decisionId === decisionId && row.organizationId === ctx.organizationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((link) => {
          const item = workItemsStore.find((w) => w.id === link.workItemId);
          return {
            link,
            workItemTitle: item?.title ?? '',
            workItemState: item?.state ?? '',
            workItemOwnerName: item?.ownerUserId ? 'Lina Samir' : null,
            workItemDueAt: item?.dueAt ?? null,
          };
        }),
    findById: async (_runner: unknown, ctx: TenantContext, linkId: string) =>
      store.find((row) => row.id === linkId && row.organizationId === ctx.organizationId) ?? null,
    findMemberName: async () => 'Lina Samir',
    create: async (_runner: unknown, ctx: TenantContext, input: CreateDecisionWorkLinkInput) => {
      if (
        store.some(
          (row) =>
            row.organizationId === ctx.organizationId &&
            row.decisionId === input.decisionId &&
            row.workItemId === input.workItemId,
        )
      ) {
        throw new DuplicateDecisionWorkLinkError(input.decisionId, input.workItemId);
      }
      const row = {
        id: `link-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        decisionId: input.decisionId,
        workItemId: input.workItemId,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as DecisionWorkLinkRow;
      store.push(row);
      return row;
    },
    deleteById: async (_runner: unknown, ctx: TenantContext, linkId: string) => {
      const index = store.findIndex(
        (row) => row.id === linkId && row.organizationId === ctx.organizationId,
      );
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as DecisionWorkLinksRepository;

  const service = new DecisionWorkLinksService(database, linksRepo, decisionsRepo, workItemsRepo);
  return { controller: new DecisionWorkLinksController(service), store };
}

describe('DecisionWorkLinksController link → list → unlink', () => {
  it('links a work item to a decision, lists it, and unlinks it', async () => {
    const { controller, store } = build({});

    const created = await controller.link(context, owner, DECISION, { workItemId: WORK_ITEM });
    expect(created.decisionId).toBe(DECISION);
    expect(created.workItemId).toBe(WORK_ITEM);
    expect(created.workItemTitle).toBe('Draft the brief');
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, DECISION);
    expect(listed.workLinks.map((l) => l.linkId)).toEqual([created.linkId]);

    await controller.unlink(context, owner, DECISION, created.linkId);
    expect(store).toHaveLength(0);
  });

  it('A15: a link carries its owner name and due date for the decision page', async () => {
    const { controller } = build({});
    const created = await controller.link(context, owner, DECISION, { workItemId: WORK_ITEM });
    expect(created.workItemOwnerName).toBe('Lina Samir');
    expect(created.workItemDueAt).toBeNull();
    const listed = await controller.list(context, owner, DECISION);
    expect(listed.workLinks[0]?.workItemOwnerName).toBe('Lina Samir');
    expect(listed.workLinks[0]?.workItemDueAt).toBeNull();
  });
});

describe('a duplicate pair is a 409 with no second row', () => {
  it('rejects linking the same work item twice', async () => {
    const { controller, store } = build({});
    await controller.link(context, owner, DECISION, { workItemId: WORK_ITEM });
    await expect(
      controller.link(context, owner, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(store).toHaveLength(1);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('link against an unknown decision is a 404 and writes nothing', async () => {
    const { controller, store } = build({ decisions: [] });
    await expect(
      controller.link(context, owner, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('link a work item from another project is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      workItemsSeed: [workItemRow(WORK_ITEM, ORG, OTHER_PROJECT)],
    });
    await expect(
      controller.link(context, owner, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('link a soft-deleted work item is a 404 and writes nothing', async () => {
    const { controller, store } = build({
      workItemsSeed: [workItemRow(WORK_ITEM, ORG, PROJECT, new Date())],
    });
    await expect(
      controller.link(context, owner, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant decision is invisible to link (resolved tenant-scoped first)', async () => {
    const { controller, store } = build({
      decisions: [decisionRow(DECISION, OTHER_ORG, PROJECT)],
    });
    await expect(
      controller.link(context, owner, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('unlink an unknown link is a 404', async () => {
    const { controller } = build({});
    await expect(
      controller.unlink(context, owner, DECISION, 'link-0000-0000-0000-0000000000ff'),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
  });

  it('unlink a link that belongs to another decision is a 404 and writes nothing', async () => {
    const foreign = {
      id: 'link-0000-0000-0000-0000000000aa',
      organizationId: ORG,
      decisionId: 'decision-0000-0000-0000-0000000000ff',
      workItemId: WORK_ITEM,
      createdBy: USER,
      createdAt: new Date(),
    } as DecisionWorkLinkRow;
    const { controller, store } = build({ linksSeed: [foreign] });
    await expect(controller.unlink(context, owner, DECISION, foreign.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store).toHaveLength(1);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the decision’s project may link and unlink', async () => {
    const { controller, store } = build({});
    const created = await controller.link(context, managerOnProject, DECISION, {
      workItemId: WORK_ITEM,
    });
    await controller.unlink(context, managerOnProject, DECISION, created.linkId);
    expect(store).toHaveLength(0);
  });

  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build({});
    await expect(
      controller.link(context, managerElsewhere, DECISION, { workItemId: WORK_ITEM }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires meeting.write to link/unlink and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(DecisionWorkLinksController.prototype.link)).toBe('meeting.write');
    expect(cap(DecisionWorkLinksController.prototype.unlink)).toBe('meeting.write');
    expect(cap(DecisionWorkLinksController.prototype.list)).toBe('work.read');
  });
});
