import { describe, expect, it } from 'vitest';
import type { Principal, Role } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsService } from './conversations.service.js';
import type { ConversationRow, WorkItemRow } from '../../common/database/schema.js';
import { CHANNEL_ROW_DEFAULTS } from '../../../test/support/conversation-fixtures.js';

/**
 * Wave 10 R3, message-to-work conversion.
 *
 * N02: a retry of an already-converted message used to hand back the existing work item
 * whatever had happened to it since — moved to a project the caller is not on, or deleted.
 * Now the item comes back only when the caller may `work.read` it where it is now; otherwise
 * one 409 `message_already_converted` with no work item fields, whatever the reason.
 *
 * F26: converting straight into a client audience publishes the item to the client portal, so
 * it needs `deliverable.publish` on the conversation's project (as `WorkItemsService.create`
 * asks), refused with 403 before anything is written.
 */

const ORG = '0198f100-0000-7000-8000-000000000001';
const USER = '0198f100-0000-7000-8000-0000000000a1';
const PROJECT_A = '0198f100-0000-7000-8000-000000000b01';
const PROJECT_B = '0198f100-0000-7000-8000-000000000b02';
const CHANNEL = '0198f100-0000-7000-8000-000000000c01';
const MESSAGE = '0198f100-0000-7000-8000-000000000d01';
const WORK_ITEM = '0198f100-0000-7000-8000-000000000e01';
const SECRET_TITLE = 'Quietly renegotiate the Atlas retainer';
const SECRET_DESCRIPTION = 'Board-only: cut the retainer by a third';

const CONTEXT = {
  organizationId: ORG,
  userId: USER,
  correlationId: '0198f100-0000-7000-8000-000000000f01',
} as unknown as TenantContext;

function principal(role: Role, projectIds: readonly string[] = [PROJECT_A]): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0198f100-0000-7000-8000-000000000e99',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

const NOW = new Date('2026-10-26T09:00:00.000Z');

const conversation: ConversationRow = {
  id: CHANNEL,
  organizationId: ORG,
  projectId: PROJECT_A,
  ...CHANNEL_ROW_DEFAULTS,
  name: 'atlas-relaunch',
  nextSequenceNo: 2,
  createdByUserId: USER,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

function workItemRow(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: WORK_ITEM,
    organizationId: ORG,
    projectId: PROJECT_A,
    type: 'task',
    title: SECRET_TITLE,
    description: SECRET_DESCRIPTION,
    state: 'backlog',
    ownerUserId: null,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as WorkItemRow;
}

interface Harness {
  readonly service: ConversationsService;
  /** Every work item the conversion wrote — what the client portal would list. */
  readonly created: WorkItemRow[];
  readonly events: unknown[];
}

function harness(existingItem: WorkItemRow | null = null): Harness {
  const created: WorkItemRow[] = [];
  const events: unknown[] = [];
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const conversations = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      id === CHANNEL ? conversation : null,
    // The caller holds a row in the channel.
    findMembership: async () => ({ conversationId: CHANNEL, userId: USER, joinedAt: NOW }),
    findMessageById: async (_r: unknown, _c: unknown, id: string) =>
      id === MESSAGE
        ? { id, conversationId: CHANNEL, body: 'Please send the revised retainer', deletedAt: null }
        : null,
    findWorkLinkByMessage: async () =>
      existingItem === null
        ? null
        : { messageId: MESSAGE, workItemId: existingItem.id, createdAt: NOW },
    createWorkLink: async () => ({ messageId: MESSAGE, workItemId: WORK_ITEM, createdAt: NOW }),
  };
  const projects = {
    findById: async (_r: unknown, _c: unknown, id: string) => ({ id, archivedAt: null }),
  };
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      existingItem !== null && existingItem.id === id ? existingItem : null,
    create: async (_r: unknown, _c: unknown, input: Partial<WorkItemRow>) => {
      const row = workItemRow({
        title: input.title ?? 'untitled',
        description: null,
        audience: input.audience ?? 'internal',
      });
      created.push(row);
      return row;
    },
  };
  const outbox = {
    append: async (_tx: unknown, _c: unknown, event: unknown) => events.push(event),
  };
  const service = new ConversationsService(
    database,
    conversations as never,
    undefined,
    projects as never,
    undefined,
    workItems as never,
    outbox as never,
  );
  return { service, created, events };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('wave10 R3 N02: a re-conversion never hands back an item the caller cannot read', () => {
  it('item moved to project B the caller is not on: 409 with no title or description', async () => {
    const { service, created } = harness(workItemRow({ projectId: PROJECT_B }));
    const error = await refusal(
      service.convertMessageToWork(CONTEXT, principal('member'), CHANNEL, MESSAGE),
    );
    expect(error.status).toBe(409);
    expect(error.code).toBe('conflict');
    expect(error.auditCode).toBe('message_already_converted');
    const serialised = JSON.stringify({ message: error.message, details: error.details });
    expect(serialised).not.toContain(SECRET_TITLE);
    expect(serialised).not.toContain(SECRET_DESCRIPTION);
    expect(serialised).not.toContain(PROJECT_B);
    expect(created).toHaveLength(0);
  });

  it('item soft-deleted since the conversion: the same 409', async () => {
    const { service } = harness(workItemRow({ deletedAt: NOW }));
    const error = await refusal(
      service.convertMessageToWork(CONTEXT, principal('member'), CHANNEL, MESSAGE),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('message_already_converted');
    expect(JSON.stringify(error.details)).not.toContain(SECRET_TITLE);
  });

  it('item still readable: 200-style created:false with the existing item', async () => {
    const { service, created } = harness(workItemRow());
    const result = await service.convertMessageToWork(
      CONTEXT,
      principal('member'),
      CHANNEL,
      MESSAGE,
    );
    expect(result.created).toBe(false);
    expect(result.workItem.id).toBe(WORK_ITEM);
    expect(result.workItem.title).toBe(SECRET_TITLE);
    expect(created).toHaveLength(0);
  });
});

describe('wave10 R3 F26: converting into a client audience needs deliverable.publish', () => {
  for (const role of ['member', 'moderator'] as const) {
    for (const audience of ['client_visible', 'client_action_required'] as const) {
      it(`${role} converting with audience ${audience}: 403, no work item, no portal event`, async () => {
        const { service, created, events } = harness();
        const error = await refusal(
          service.convertMessageToWork(CONTEXT, principal(role), CHANNEL, MESSAGE, { audience }),
        );
        expect(error.status).toBe(403);
        expect(error.auditCode).toBe('work_item_publish_denied');
        expect(created).toHaveLength(0);
        expect(events).toHaveLength(0);
      });
    }
  }

  it('member converting with the internal audience: created', async () => {
    const { service, created } = harness();
    const result = await service.convertMessageToWork(
      CONTEXT,
      principal('member'),
      CHANNEL,
      MESSAGE,
      { audience: 'internal' },
    );
    expect(result.created).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('manager converting with audience client_visible: created', async () => {
    const { service, created } = harness();
    const result = await service.convertMessageToWork(
      CONTEXT,
      principal('manager'),
      CHANNEL,
      MESSAGE,
      { audience: 'client_visible' },
    );
    expect(result.created).toBe(true);
    expect(result.workItem.audience).toBe('client_visible');
    expect(created).toHaveLength(1);
  });
});
