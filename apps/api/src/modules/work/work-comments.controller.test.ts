import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkCommentsController } from './work-comments.controller.js';
import { WorkCommentsService } from './work-comments.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemCommentRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * x147 — the fast, database-free proof of the comments sub-resource. It runs the controller over
 * an in-memory comment store and a fake work-item lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write) and the read/write capability
 * gates are the behaviours a wiring bug would break, and none of them needs MySQL. The composite
 * foreign key and the append-only trigger are proved against the real engine by the chain's DB
 * suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An internal member related to exactly the projects listed. */
function member(projectIds: readonly string[]): Principal {
  return {
    userId: '01890000-0000-7000-8000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

function workItem(over: Partial<WorkItemRow> = {}): WorkItemRow {
  const now = new Date();
  return {
    id: WORK_ID,
    organizationId: ORG,
    projectId: PROJECT,
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
    ...over,
  };
}

/** An in-memory comment store standing in for the repository, counting its writes. */
class FakeCommentsRepository {
  readonly rows: WorkItemCommentRow[] = [];
  creates = 0;

  async findComment(_r: unknown, _c: TenantContext, workItemId: string, commentId: string) {
    return this.rows.find((row) => row.workItemId === workItemId && row.id === commentId) ?? null;
  }

  async listForWorkItem(_r: unknown, _c: TenantContext, workItemId: string) {
    return this.rows
      .filter((row) => row.workItemId === workItemId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: { workItemId: string; authorMembershipId: string; body: string },
  ) {
    this.creates += 1;
    const row: WorkItemCommentRow = {
      id: `comment-${this.rows.length + 1}`,
      organizationId: ORG,
      workItemId: input.workItemId,
      authorMembershipId: input.authorMembershipId,
      body: input.body,
      createdAt: new Date(Date.now() + this.rows.length),
    };
    this.rows.push(row);
    return row;
  }
}

function harness(parent: WorkItemRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const comments = new FakeCommentsRepository();
  const service = new WorkCommentsService(
    database,
    workItems,
    comments as unknown as ConstructorParameters<typeof WorkCommentsService>[2],
  );
  return { controller: new WorkCommentsController(service), comments };
}

async function statusOf(work: () => Promise<unknown>): Promise<number> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('WorkCommentsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(workItem());
  });

  it('adds and lists comments for a related member, oldest first', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);

    const first = await controller.add(context, related, WORK_ID, { body: 'Kicked this off' });
    expect(first).toMatchObject({ body: 'Kicked this off', authorMembershipId: MEMBERSHIP });

    await controller.add(context, related, WORK_ID, { body: 'Draft is with the client' });

    const listed = await controller.list(context, related, WORK_ID);
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]).toMatchObject({ id: first.id, body: 'Kicked this off' });
    expect(listed.comments[1]?.body).toBe('Draft is with the client');
  });

  it('answers 404 and writes nothing when the parent work item is cross-tenant or absent', async () => {
    const { controller, comments } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { body: 'Should never land' }),
    );
    expect(status).toBe(404);
    expect(comments.creates).toBe(0);
  });

  it('gates the list behind read access: an unrelated member gets 404', async () => {
    const { controller } = harnessed;
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
  });

  it('refuses the comment with 403 when the caller may read the item but not update it', async () => {
    // An archived item permits an internal read for history but denies every write — real
    // `authorize`, `resource_not_active`. The reader is related, so its existence is not a secret:
    // the refusal is 403, not the 404 an unrelated caller would get.
    const { controller, comments } = harness(workItem({ state: 'archived' }));
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), WORK_ID, { body: 'No comments on archived' }),
    );
    expect(status).toBe(403);
    expect(comments.creates).toBe(0);
  });
});
