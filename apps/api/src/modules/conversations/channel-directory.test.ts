import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationMembershipRow, ConversationRow } from '../../common/database/schema.js';
import { buildChannelDirectory } from './channel-directory.js';
import { ChannelDirectoryRepository } from './channel-directory.repository.js';
import type { ChannelDirectoryFacts } from './channel-directory.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import type { ConversationView } from './conversations.service.js';

const ORG = '0198f100-0000-7000-8000-000000000001';
const ME = '0198f100-0000-7000-8000-0000000000a1';
const CLIENT = '0198f100-0000-7000-8000-0000000000a2';
const OPEN = '0198f100-0000-7000-8000-000000000c01';
const HIDDEN = '0198f100-0000-7000-8000-000000000c02';

function view(id: string, name: string, createdAt: string): ConversationView {
  return {
    id,
    projectId: 'p',
    name,
    createdByUserId: ME,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
  };
}

describe('buildChannelDirectory (CH-01)', () => {
  it('orders by last activity, counts clients and marks the viewer joined', () => {
    const quiet = view(OPEN, 'quiet', '2026-10-01T00:00:00.000Z');
    const busy = view(HIDDEN, 'busy', '2026-09-01T00:00:00.000Z');
    const facts: ChannelDirectoryFacts = {
      lastMessageAt: new Map([[HIDDEN, new Date('2026-10-17T10:00:00.000Z')]]),
      members: [
        { conversationId: HIDDEN, userId: CLIENT, displayName: 'Yuki K', joinedAt: new Date(1) },
        { conversationId: HIDDEN, userId: ME, displayName: 'Omar A', joinedAt: new Date(2) },
      ],
      clientUserIds: new Set([CLIENT]),
    };

    const [first, second] = buildChannelDirectory([quiet, busy], facts, ME);

    // Created later but never written in: the busy channel's message is newer.
    expect(first?.name).toBe('busy');
    expect(first?.lastActivityAt).toBe('2026-10-17T10:00:00.000Z');
    expect(first?.joined).toBe(true);
    expect(first?.clientMemberCount).toBe(1);
    expect(first?.memberPreview.map((m) => m.userId)).toEqual([ME, CLIENT]);
    expect(second?.lastActivityAt).toBe(quiet.createdAt);
    expect(second?.joined).toBe(false);
  });
});

describe('ConversationsService.directory', () => {
  it('reads member facts only for channels the caller may reach', async () => {
    const row = (id: string): ConversationRow => ({
      id,
      organizationId: ORG,
      projectId: 'p',
      name: id,
      nextSequenceNo: 1,
      createdByUserId: ME,
      version: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      archivedAt: null,
    });
    class Conversations extends ConversationsRepository {
      override list = async () => [row(OPEN), row(HIDDEN)];
      override findMembership = async (_r: unknown, _c: unknown, id: string) =>
        id === OPEN ? ({ userId: ME } as ConversationMembershipRow) : null;
    }
    const asked: string[][] = [];
    class Facts extends ChannelDirectoryRepository {
      override facts = async (_r: unknown, _c: unknown, ids: readonly string[]) => {
        asked.push([...ids]);
        return { lastMessageAt: new Map(), members: [], clientUserIds: new Set<string>() };
      };
    }
    const database = {
      read: <T>(_c: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    } as unknown as TenantDatabase;
    const service = new ConversationsService(
      database,
      new Conversations(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new Facts(),
    );
    // A project member without org-wide scope: channel membership decides.
    const principal: Principal = {
      userId: ME,
      organizationId: ORG,
      kind: 'internal',
      role: 'member',
      membershipId: 'm',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: ['p'],
      hasOrgWideScope: false,
    };

    const channels = await service.directory({ organizationId: ORG } as TenantContext, principal);

    expect(channels.map((c) => c.id)).toEqual([OPEN]);
    expect(asked).toEqual([[OPEN]]);
  });
});
