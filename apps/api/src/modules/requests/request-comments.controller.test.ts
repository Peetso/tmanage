import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { RequestCommentsController } from './request-comments.controller.js';
import { RequestCommentsService } from './request-comments.service.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestCommentRow } from '../../common/database/schema.js';

/**
 * x299 — the fast, database-free proof of the request-comments sub-resource. It runs the controller
 * over an in-memory comment store and a fake request lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), the missing-capability 403, the
 * one-level-of-reply rule and the retract-with-replies delete are the behaviours a wiring bug would
 * break, and none needs MySQL. The composite foreign keys and the append-only trigger are proved
 * against the real engine by the chain's DB suite, not here.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000101';
const REQUEST_ID = 'request-0000-0000-0000-0000-000000000201';
const MEMBERSHIP = 'membership-0000-0000-0000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

/** An internal manager scoped to exactly the projects listed. */
function manager(projectIds: readonly string[]): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

/** A client of this org — never holds `client_request.triage` (internal-only). */
function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function request(): ClientRequestRow {
  return { id: REQUEST_ID, organizationId: ORG, projectId: PROJECT } as unknown as ClientRequestRow;
}

/** An in-memory comment store standing in for the repository, counting its writes. */
class FakeCommentsRepository {
  readonly rows: RequestCommentRow[] = [];
  creates = 0;
  deletes = 0;

  async findComment(_r: unknown, _c: TenantContext, requestId: string, commentId: string) {
    return this.rows.find((row) => row.requestId === requestId && row.id === commentId) ?? null;
  }

  async listForRequest(_r: unknown, _c: TenantContext, requestId: string) {
    return this.rows
      .filter((row) => row.requestId === requestId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: { requestId: string; parentId: string | null; authorMembershipId: string; body: string },
  ) {
    this.creates += 1;
    const row: RequestCommentRow = {
      id: `comment-${this.rows.length + 1}`,
      organizationId: ORG,
      requestId: input.requestId,
      parentId: input.parentId,
      authorMembershipId: input.authorMembershipId,
      body: input.body,
      createdAt: new Date(Date.now() + this.rows.length),
    };
    this.rows.push(row);
    return row;
  }

  async deleteWithReplies(_r: unknown, _c: TenantContext, requestId: string, commentId: string) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i] as RequestCommentRow;
      if (row.requestId === requestId && (row.id === commentId || row.parentId === commentId)) {
        this.rows.splice(i, 1);
      }
    }
    this.deletes += before - this.rows.length;
  }
}

function harness(parent: ClientRequestRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const requests = { findById: async () => parent } as unknown as ClientRequestsRepository;
  const comments = new FakeCommentsRepository();
  const service = new RequestCommentsService(
    database,
    requests,
    comments as unknown as ConstructorParameters<typeof RequestCommentsService>[2],
  );
  return { controller: new RequestCommentsController(service), comments };
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

describe('RequestCommentsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(request());
  });

  it('adds and lists comments for a related manager, oldest first', async () => {
    const { controller } = harnessed;
    const related = manager([PROJECT]);

    const first = await controller.add(context, related, REQUEST_ID, { body: 'Looks in-scope' });
    expect(first).toMatchObject({
      body: 'Looks in-scope',
      authorMembershipId: MEMBERSHIP,
      parentId: null,
    });

    await controller.add(context, related, REQUEST_ID, { body: 'Flagging the budget line' });

    const listed = await controller.list(context, related, REQUEST_ID);
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]?.body).toBe('Looks in-scope');
    expect(listed.comments[1]?.body).toBe('Flagging the budget line');
  });

  it('threads one level of reply and refuses a reply-to-a-reply with 400 no-insert', async () => {
    const { controller, comments } = harnessed;
    const related = manager([PROJECT]);

    const top = await controller.add(context, related, REQUEST_ID, { body: 'Top-level' });
    const reply = await controller.add(context, related, REQUEST_ID, {
      body: 'A reply',
      parentId: top.id,
    });
    expect(reply.parentId).toBe(top.id);

    const status = await statusOf(() =>
      controller.add(context, related, REQUEST_ID, { body: 'Nested too deep', parentId: reply.id }),
    );
    expect(status).toBe(400);
    expect(comments.rows).toHaveLength(2);
  });

  it('refuses a parentId that names nothing in this request with 400 no-insert', async () => {
    const { controller, comments } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, manager([PROJECT]), REQUEST_ID, { body: 'Orphan', parentId: 'nope' }),
    );
    expect(status).toBe(400);
    expect(comments.creates).toBe(0);
  });

  it('rejects an empty body with 400 no-insert', async () => {
    const { controller, comments } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, manager([PROJECT]), REQUEST_ID, { body: '   ' }),
    );
    expect(status).toBe(400);
    expect(comments.creates).toBe(0);
  });

  it('answers 404 and writes nothing when the request is cross-tenant or absent', async () => {
    const { controller, comments } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, manager([PROJECT]), REQUEST_ID, { body: 'Should never land' }),
    );
    expect(status).toBe(404);
    expect(comments.creates).toBe(0);
  });

  it('refuses a caller without client_request.triage (a client) with 403 no-insert', async () => {
    const { controller, comments } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, client(), REQUEST_ID, { body: 'Clients cannot post internal notes' }),
    );
    expect(status).toBe(403);
    expect(comments.creates).toBe(0);
  });

  it('refuses a manager with no relation to the request project with 403 no-insert', async () => {
    const { controller, comments } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, manager(['project-elsewhere']), REQUEST_ID, {
        body: 'Not my project',
      }),
    );
    expect(status).toBe(403);
    expect(comments.creates).toBe(0);
  });

  it('retracts a comment and its replies, and 404s a comment of another request', async () => {
    const { controller, comments } = harnessed;
    const related = manager([PROJECT]);
    const top = await controller.add(context, related, REQUEST_ID, { body: 'Parent' });
    await controller.add(context, related, REQUEST_ID, { body: 'Child', parentId: top.id });
    expect(comments.rows).toHaveLength(2);

    await controller.remove(context, related, REQUEST_ID, top.id);
    expect(comments.rows).toHaveLength(0);
    expect(comments.deletes).toBe(2);

    const status = await statusOf(() => controller.remove(context, related, REQUEST_ID, 'ghost'));
    expect(status).toBe(404);
  });
});
