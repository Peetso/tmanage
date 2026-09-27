import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { ConversationSearchController } from './conversation-search.controller.js';
import { ConversationSearchService } from './conversation-search.service.js';
import type { ConversationsService } from './conversations.service.js';
import type { ConversationSearchRepository } from './conversation-search.repository.js';
import type { MessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * CH-10 in-conversation search (x253) proofs, database-free. The refusal that matters — a
 * conversation in another tenant answers 404 with no message read — is proved here by making
 * the reused `ConversationsService.get` refuse, exactly as its tenant-scoped `findById` does in
 * the running system, and asserting the search repository is never touched. The `LIKE` scan
 * itself is the chain's DB suite, not this file.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const CONVERSATION = 'conversation-0000-0000-0000-000000000001';

function principal(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

const database = {
  read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function messageRow(id: string, body: string): MessageRow {
  return {
    id,
    organizationId: ORG,
    conversationId: CONVERSATION,
    authorUserId: USER,
    sequenceNo: 1,
    parentMessageId: null,
    depth: 0,
    parentDepth: null,
    body,
    bodyRich: null,
    clientGeneratedId: null,
    editedAt: null,
    deletedAt: null,
    deletedByUserId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  } as unknown as MessageRow;
}

/** A search service whose gate (`get`) is reachable and whose repository records its calls. */
function reachableService(rows: readonly MessageRow[]) {
  const calls: unknown[] = [];
  const conversations = {
    get: async () => ({ id: CONVERSATION }),
  } as unknown as ConversationsService;
  const repository = {
    searchMessages: async (_runner: unknown, _context: TenantContext, query: unknown) => {
      calls.push(query);
      return rows;
    },
  } as unknown as ConversationSearchRepository;
  return { service: new ConversationSearchService(database, conversations, repository), calls };
}

/** A search service whose gate refuses with 404, as a cross-tenant conversation does. */
function refusingService() {
  const calls: unknown[] = [];
  const conversations = {
    get: async () => {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    },
  } as unknown as ConversationsService;
  const repository = {
    searchMessages: async (_runner: unknown, _context: TenantContext, query: unknown) => {
      calls.push(query);
      return [];
    },
  } as unknown as ConversationSearchRepository;
  return { service: new ConversationSearchService(database, conversations, repository), calls };
}

describe('ConversationSearchService', () => {
  it('refuses a conversation in another tenant with 404 and reads no messages', async () => {
    const { service, calls } = refusingService();
    await expect(
      service.searchMessages(context, principal(), CONVERSATION, { q: 'atlas' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([]); // the gate refused before any message was read
  });

  it('returns a truncated snippet around the match, without organizationId', async () => {
    const body = `${'x'.repeat(200)} Atlas relaunch ${'y'.repeat(200)}`;
    const { service } = reachableService([messageRow('m1', body)]);
    const results = await service.searchMessages(context, principal(), CONVERSATION, {
      q: 'atlas',
    });
    expect(results).toHaveLength(1);
    const [match] = results;
    expect(match?.id).toBe('m1');
    expect(match?.snippet.toLowerCase()).toContain('atlas relaunch');
    expect(match?.snippet.startsWith('…') && match?.snippet.endsWith('…')).toBe(true);
    expect(match).not.toHaveProperty('organizationId');
  });

  it('returns an empty result for a blank query without reading', async () => {
    const { service, calls } = reachableService([messageRow('m1', 'anything')]);
    const results = await service.searchMessages(context, principal(), CONVERSATION, { q: '   ' });
    expect(results).toEqual([]);
    expect(calls).toEqual([]); // resolved the conversation, but never scanned it
  });
});

describe('ConversationSearchController', () => {
  it('rejects a non-positive page or limit with 400', async () => {
    const controller = new ConversationSearchController(reachableService([]).service);
    await expect(
      controller.run(context, principal(), CONVERSATION, 'atlas', '0'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.run(context, principal(), CONVERSATION, 'atlas', undefined, '-1'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
