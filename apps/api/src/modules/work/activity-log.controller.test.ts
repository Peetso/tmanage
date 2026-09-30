import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkActivityLogController } from './activity-log.controller.js';
import { WorkActivityLogService } from './activity-log.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { AuditEventsRepository } from '../audit/audit-events.repository.js';
import type { WorkCommentsRepository } from './work-comments.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  AuditEventRow,
  WorkItemCommentRow,
  WorkItemRow,
} from '../../common/database/schema.js';

/**
 * x291 — the database-free proof of the activity timeline. It runs the controller over fake audit
 * and comment reads and a fake work-item lookup, with the **real** `authorize`. Two behaviours a
 * wiring bug would break and neither needs MySQL: the merge-and-sort (newest first, both sources)
 * and the resolve-then-authorize refusal — a cross-tenant parent is a 404 read from NO source
 * table, so an outsider learns nothing and reads not one audit or comment row.
 */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const WORK_ID = '01890000-0000-7000-8000-000000000201';
const MEMBERSHIP = '01890000-0000-7000-8000-000000000011';

const context = { organizationId: ORG } as unknown as TenantContext;

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
  } as Principal;
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
  } as WorkItemRow;
}

/** Fake source repositories that count their reads, so "no rows read" is provable. */
function harness(
  parent: WorkItemRow | null,
  audit: AuditEventRow[],
  comments: WorkItemCommentRow[],
) {
  const counters = { audit: 0, comments: 0 };
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const workItems = { findById: async () => parent } as unknown as WorkItemsRepository;
  const auditRepo = {
    historyOf: async () => {
      counters.audit += 1;
      return audit;
    },
  } as unknown as AuditEventsRepository;
  const commentsRepo = {
    listForWorkItem: async () => {
      counters.comments += 1;
      return comments;
    },
  } as unknown as WorkCommentsRepository;
  const service = new WorkActivityLogService(database, workItems, auditRepo, commentsRepo);
  return { controller: new WorkActivityLogController(service), counters };
}

function auditRow(over: Partial<AuditEventRow>): AuditEventRow {
  return {
    id: 'aud-1',
    organizationId: ORG,
    actorUserId: 'user-actor',
    effectiveActorId: null,
    action: 'work_item.transitioned',
    objectType: 'work_item',
    objectId: WORK_ID,
    result: 'allowed',
    correlationId: 'corr-1',
    metadataJson: {},
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    ...over,
  } as AuditEventRow;
}

function commentRow(over: Partial<WorkItemCommentRow>): WorkItemCommentRow {
  return {
    id: 'cmt-1',
    organizationId: ORG,
    workItemId: WORK_ID,
    authorMembershipId: MEMBERSHIP,
    body: 'Looks good to me',
    createdAt: new Date('2026-01-01T11:00:00.000Z'),
    ...over,
  } as WorkItemCommentRow;
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

describe('WorkActivityLogController', () => {
  it('merges audit events and comments into one feed, newest first', async () => {
    const { controller } = harness(
      workItem(),
      [auditRow({ action: 'work_item.transitioned' })],
      [commentRow({ body: 'Looks good to me' })],
    );

    const { activity } = await controller.list(context, member([PROJECT]), WORK_ID);

    expect(activity.map((e) => e.kind)).toEqual(['comment', 'audit']); // 11:00 before 10:00
    expect(activity[0]).toMatchObject({
      kind: 'comment',
      action: 'work_item.commented',
      actorId: MEMBERSHIP,
      summary: 'Looks good to me',
    });
    expect(activity[1]).toMatchObject({
      kind: 'audit',
      action: 'work_item.transitioned',
      actorId: 'user-actor',
      summary: 'Changed the status',
    });
  });

  it('answers 404 and reads NO source row when the parent is cross-tenant or absent', async () => {
    const { controller, counters } = harness(null, [auditRow({})], [commentRow({})]);
    const status = await statusOf(() => controller.list(context, member([PROJECT]), WORK_ID));
    expect(status).toBe(404);
    expect(counters).toEqual({ audit: 0, comments: 0 });
  });

  it('gates read access: an unrelated member gets 404 with no source row read', async () => {
    const { controller, counters } = harness(workItem(), [auditRow({})], [commentRow({})]);
    const status = await statusOf(() => controller.list(context, member([]), WORK_ID));
    expect(status).toBe(404);
    expect(counters).toEqual({ audit: 0, comments: 0 });
  });
});
