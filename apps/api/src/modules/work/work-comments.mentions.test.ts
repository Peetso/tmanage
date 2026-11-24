import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkCommentsController } from './work-comments.controller.js';
import { WorkCommentsService } from './work-comments.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemCommentRow, WorkItemRow } from '../../common/database/schema.js';
import type { MentionSearchInput } from '../files/review-mention-candidates.repository.js';

/**
 * 53-11 — @mentions in a work item's comments, database-free with the real `authorize`: only people
 * who can see the item are offered and notified, the author never notifies themself, and a caller
 * who cannot read the item learns nothing about who is on it.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const ME = '01890000-0000-7000-8000-000000000001';
const LINA = '01890000-0000-7000-8000-000000000002';
const OUTSIDER = '01890000-0000-7000-8000-000000000003';

const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;

function member(projectIds: readonly string[]): Principal {
  return {
    userId: ME,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '01890000-0000-7000-8000-000000000011',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

const item = {
  id: WORK_ID,
  organizationId: ORG,
  projectId: PROJECT,
  audience: 'internal',
  state: 'in_progress',
  deletedAt: null,
} as unknown as WorkItemRow;

/** Who is on the project: me and Lina. The outsider is in the org but not on the project. */
const ON_PROJECT = [
  { userId: ME, displayName: 'Me Myself', kind: 'internal' as const },
  { userId: LINA, displayName: 'Lina Samir', kind: 'internal' as const },
];

function harness(ai: { readonly aiUserIds?: readonly string[]; readonly on?: boolean } = {}) {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => item } as unknown as WorkItemsRepository;
  const comments = {
    authors: async () => [],
    create: async (_r: unknown, _c: unknown, input: { body: string }) =>
      ({
        id: 'comment-1',
        workItemId: WORK_ID,
        authorMembershipId: 'm',
        body: input.body,
        createdAt: new Date(),
      }) as unknown as WorkItemCommentRow,
  };
  const searches: MentionSearchInput[] = [];
  const people = {
    search: async (_r: unknown, _c: unknown, input: MentionSearchInput) => {
      searches.push(input);
      return ON_PROJECT.filter(
        (row) => input.userIds === undefined || input.userIds.includes(row.userId),
      );
    },
  };
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const outbox = {
    append: async (_r: unknown, _c: unknown, event: { type: string; payload: never }) => {
      events.push(event);
    },
  };
  const service = new WorkCommentsService(
    database,
    workItems,
    comments as never,
    undefined,
    outbox as never,
    people,
    {
      kinds: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            { membershipId: `m-${id}`, kind: ai.aiUserIds?.includes(id) ? 'ai' : 'human' },
          ]),
        ) as never,
    },
    ai.on ?? false,
  );
  return { controller: new WorkCommentsController(service), events, searches };
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

describe('work item comment @mentions (53-11)', () => {
  it('notifies only mentioned people who can see the item, never the author', async () => {
    const { controller, events, searches } = harness();
    await controller.add(context, member([PROJECT]), WORK_ID, {
      body: `@${LINA} and @${OUTSIDER} please check; cc @${ME}`,
    });
    const notices = events.filter((e) => e.type === 'work_item.comment_created.v1');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({
      workItemId: WORK_ID,
      commentId: 'comment-1',
      projectId: PROJECT,
      authorUserId: ME,
      mentionedUserIds: [LINA],
    });
    // Comments are internal: client contacts are never candidates.
    expect(searches[0]).toMatchObject({ projectId: PROJECT, includeClients: false });
  });

  it('writes no event when nobody mentioned can see the item', async () => {
    const { controller, events } = harness();
    await controller.add(context, member([PROJECT]), WORK_ID, { body: `@${OUTSIDER} hi` });
    await controller.add(context, member([PROJECT]), WORK_ID, { body: 'no mentions at all' });
    expect(events.filter((e) => e.type === 'work_item.comment_created.v1')).toHaveLength(0);
  });

  it('53-01: frames every comment live with ids only, mentions or not', async () => {
    const { controller, events } = harness();
    await controller.add(context, member([PROJECT]), WORK_ID, { body: 'no mentions at all' });
    expect(events).toEqual([
      {
        type: 'work_item.commented.v1',
        aggregateId: WORK_ID,
        payload: { workItemId: WORK_ID, commentId: 'comment-1', projectId: PROJECT },
      },
    ]);
  });

  it('offers the people who can see the item as @<userId> tokens, the caller excluded', async () => {
    const { controller } = harness();
    const { candidates } = await controller.mentionCandidates(
      context,
      member([PROJECT]),
      WORK_ID,
      'li',
    );
    expect(candidates).toEqual([
      { userId: LINA, displayName: 'Lina Samir', mention: `@${LINA}`, kind: 'human' },
    ]);
  });

  it('60-08 (S7d): marks an AI employee while AI is on, and leaves him out while it is off', async () => {
    const on = await harness({ aiUserIds: [LINA], on: true }).controller.mentionCandidates(
      context,
      member([PROJECT]),
      WORK_ID,
      'li',
    );
    expect(on.candidates).toEqual([
      { userId: LINA, displayName: 'Lina Samir', mention: `@${LINA}`, kind: 'ai' },
    ]);
    const off = await harness({ aiUserIds: [LINA], on: false }).controller.mentionCandidates(
      context,
      member([PROJECT]),
      WORK_ID,
      'li',
    );
    expect(off.candidates).toEqual([]);
  });

  it('answers 404 to a caller who cannot read the item, and 400 to a bad limit', async () => {
    const { controller, searches } = harness();
    expect(await statusOf(() => controller.mentionCandidates(context, member([]), WORK_ID))).toBe(
      404,
    );
    expect(searches).toHaveLength(0);
    expect(
      await statusOf(() =>
        controller.mentionCandidates(context, member([PROJECT]), WORK_ID, '', '99'),
      ),
    ).toBe(400);
  });
});
