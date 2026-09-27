import { beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { DecisionCommentsController } from './comments.controller.js';
import { DecisionCommentsService } from './comments.service.js';
import type { DecisionsRepository } from './decisions.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DecisionCommentRow, DecisionRow } from '../../common/database/schema.js';

/**
 * x317 — the database-free proof of the decision-comment thread. It runs the controller over an
 * in-memory comment store and a fake decision lookup, with the **real** `authorize`: the
 * resolve-then-authorize order, the cross-tenant 404 (no write), the 403 for a caller lacking
 * `work.read` on the decision's project (no insert), and delete-own-only (no delete of another
 * member's comment) are the behaviours a wiring bug would break, and none of them needs MySQL. The
 * composite foreign key and the append-only trigger are proved against the real engine by the
 * chain's DB suite, not here.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const DECISION = '01890000-0000-7000-8000-000000000301';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';
const OTHER_MEMBERSHIP = '01890000-0000-7000-8000-000000000012';

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

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

function decision(over: Partial<DecisionRow> = {}): DecisionRow {
  const now = new Date();
  return {
    id: DECISION,
    organizationId: ORG,
    projectId: PROJECT,
    meetingId: null,
    title: 'Adopt the new brand palette',
    statement: 'We will ship the revised palette in Q4.',
    status: 'accepted',
    decidedBy: '01890000-0000-7000-8000-000000000001',
    decidedAt: now,
    createdAt: now,
    ...over,
  };
}

/** An in-memory comment store standing in for the repository, counting its writes and deletes. */
class FakeCommentsRepository {
  readonly rows: DecisionCommentRow[] = [];
  creates = 0;
  deletes = 0;

  async findComment(_r: unknown, _c: TenantContext, decisionId: string, commentId: string) {
    return this.rows.find((row) => row.decisionId === decisionId && row.id === commentId) ?? null;
  }

  async listForDecision(_r: unknown, _c: TenantContext, decisionId: string) {
    return this.rows
      .filter((row) => row.decisionId === decisionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async create(
    _r: unknown,
    _c: TenantContext,
    input: { decisionId: string; authorMembershipId: string; body: string },
  ) {
    this.creates += 1;
    const row: DecisionCommentRow = {
      id: `comment-${this.rows.length + 1}`,
      organizationId: ORG,
      decisionId: input.decisionId,
      authorMembershipId: input.authorMembershipId,
      body: input.body,
      createdAt: new Date(Date.now() + this.rows.length),
    };
    this.rows.push(row);
    return row;
  }

  async deleteOwn(
    _r: unknown,
    _c: TenantContext,
    decisionId: string,
    commentId: string,
    authorMembershipId: string,
  ) {
    this.deletes += 1;
    const index = this.rows.findIndex(
      (row) =>
        row.decisionId === decisionId &&
        row.id === commentId &&
        row.authorMembershipId === authorMembershipId,
    );
    if (index >= 0) this.rows.splice(index, 1);
  }
}

function harness(parent: DecisionRow | null) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const decisions = { findById: async () => parent } as unknown as DecisionsRepository;
  const comments = new FakeCommentsRepository();
  const service = new DecisionCommentsService(
    database,
    decisions,
    comments as unknown as ConstructorParameters<typeof DecisionCommentsService>[2],
  );
  return { controller: new DecisionCommentsController(service), comments };
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

describe('DecisionCommentsController', () => {
  let harnessed: ReturnType<typeof harness>;

  beforeEach(() => {
    harnessed = harness(decision());
  });

  it('adds and lists comments for a related member, oldest first', async () => {
    const { controller } = harnessed;
    const related = member([PROJECT]);

    const first = await controller.add(context, related, DECISION, { body: 'Agreed' });
    expect(first).toMatchObject({ body: 'Agreed', authorMembershipId: MEMBERSHIP });

    await controller.add(context, related, DECISION, { body: 'Noting the risk' });

    const listed = await controller.list(context, related, DECISION);
    expect(listed.comments).toHaveLength(2);
    expect(listed.comments[0]?.body).toBe('Agreed');
    expect(listed.comments[1]?.body).toBe('Noting the risk');
  });

  it('answers 404 and writes nothing when the decision is cross-tenant or absent', async () => {
    const { controller, comments } = harness(null);
    const status = await statusOf(() =>
      controller.add(context, member([PROJECT]), DECISION, { body: 'Should never land' }),
    );
    expect(status).toBe(404);
    expect(comments.creates).toBe(0);
  });

  it('refuses the comment with 403 and no insert when the caller lacks work.read on the decision', async () => {
    // The decision resolves within the tenant, but the member is not related to its project, so real
    // `authorize` denies `work.read`. Its existence within the tenant is not hidden from an
    // authenticated member, so the refusal is 403, not 404 — and nothing is written.
    const { controller, comments } = harnessed;
    const status = await statusOf(() =>
      controller.add(context, member([]), DECISION, { body: 'No standing here' }),
    );
    expect(status).toBe(403);
    expect(comments.creates).toBe(0);
  });

  it('deletes the caller’s own comment (204) and is idempotent for an absent comment', async () => {
    const { controller, comments } = harnessed;
    const related = member([PROJECT]);
    const created = await controller.add(context, related, DECISION, { body: 'Mine to remove' });

    await expect(
      controller.remove(context, related, DECISION, created.id),
    ).resolves.toBeUndefined();
    expect(comments.rows).toHaveLength(0);

    // Deleting it again is a no-op that still resolves (idempotent 204).
    await expect(
      controller.remove(context, related, DECISION, created.id),
    ).resolves.toBeUndefined();
  });

  it('refuses deleting another member’s comment with 403 and no delete', async () => {
    const { controller, comments } = harnessed;
    comments.rows.push({
      id: 'comment-x',
      organizationId: ORG,
      decisionId: DECISION,
      authorMembershipId: OTHER_MEMBERSHIP,
      body: 'Written by someone else',
      createdAt: new Date(),
    });
    const status = await statusOf(() =>
      controller.remove(context, member([PROJECT]), DECISION, 'comment-x'),
    );
    expect(status).toBe(403);
    expect(comments.deletes).toBe(0);
    expect(comments.rows).toHaveLength(1);
  });
});
