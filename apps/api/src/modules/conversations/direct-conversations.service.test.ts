import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DirectConversationRow } from '../../common/database/schema.js';
import type { DirectParty } from './direct-conversations.repository.js';
import {
  DirectConversationsRepository,
  DuplicateDirectMessageError,
} from './direct-conversations.repository.js';
import { ConversationsRepository, DuplicateMessageError } from './conversations.repository.js';
import { DirectConversationsController } from './direct-conversations.controller.js';
import { DirectConversationsService, mayDirectMessage } from './direct-conversations.service.js';
import { MentionCandidatesService } from './mention-candidates.controller.js';
import type { MentionCandidatesRepository } from './mention-candidates.repository.js';

const ORG = 'org-1';
const ME = 'user-a';
const context = { organizationId: ORG, userId: ME } as unknown as TenantContext;
const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

const internal = (userId: string, projectIds: string[] = []): DirectParty => ({
  userId,
  kind: 'internal',
  clientOrganizationIds: [],
  projectIds,
});
const client = (userId: string, org: string, projectIds: string[]): DirectParty => ({
  userId,
  kind: 'client',
  clientOrganizationIds: [org],
  projectIds,
});

function principal(kind: 'internal' | 'client', role: string): Principal {
  return { userId: ME, organizationId: ORG, kind, role } as unknown as Principal;
}

describe('mayDirectMessage', () => {
  it('lets two internal members talk and keeps clients to shared projects / own client org', () => {
    expect(mayDirectMessage(internal('a'), internal('b'))).toBe(true);
    expect(mayDirectMessage(client('a', 'c1', ['p1']), internal('b', ['p1']))).toBe(true);
    expect(mayDirectMessage(client('a', 'c1', ['p1']), internal('b', ['p2']))).toBe(false);
    expect(mayDirectMessage(client('a', 'c1', ['p1']), client('b', 'c1', ['p1']))).toBe(true);
    expect(mayDirectMessage(client('a', 'c1', ['p1']), client('b', 'c2', ['p1']))).toBe(false);
    expect(mayDirectMessage(internal('a'), null)).toBe(false);
  });
});

describe('DirectConversationsService', () => {
  const pair: DirectConversationRow = {
    id: 'dm-1',
    organizationId: ORG,
    userLowId: ME,
    userHighId: 'user-b',
    nextSequenceNo: 1,
    userLowLastReadSequenceNo: 0,
    userHighLastReadSequenceNo: 0,
    createdByUserId: ME,
    lastMessageAt: null,
    createdAt: new Date('2026-10-22T00:00:00Z'),
    updatedAt: new Date('2026-10-22T00:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
  };

  function service(
    parties: Record<string, DirectParty | null>,
    existing: DirectConversationRow | null,
  ) {
    const inserted: unknown[] = [];
    const repository = {
      findParty: async (_r: unknown, _c: unknown, id: string) => parties[id] ?? null,
      findPair: async () => existing,
      insertPair: async (_r: unknown, _c: unknown, low: string, high: string) => {
        inserted.push([low, high]);
        return { row: pair, created: true };
      },
      listForUser: async () => [pair],
      participantDetails: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
        new Map(
          ids.map((id) => [
            id,
            id === 'user-b'
              ? {
                  displayName: 'Bea',
                  jobTitle: 'Art director',
                  clientCompanyName: 'Acme Ltd',
                  online: true,
                }
              : { displayName: null, jobTitle: null, clientCompanyName: null, online: false },
          ]),
        ),
    } as unknown as DirectConversationsRepository;
    return { svc: new DirectConversationsService(database, repository), inserted };
  }

  it('creates the sorted pair once, and returns the existing one on a second open', async () => {
    const parties = { [ME]: internal(ME), 'user-b': internal('user-b') };
    const first = service(parties, null);
    const opened = await first.svc.open(context, principal('internal', 'member'), 'user-b');
    expect(opened.created).toBe(true);
    expect(first.inserted).toEqual([[ME, 'user-b']]);
    expect(opened.conversation).toMatchObject({ otherUserId: 'user-b', otherDisplayName: 'Bea' });

    const again = service(parties, pair);
    const reopened = await again.svc.open(context, principal('internal', 'member'), 'user-b');
    expect(reopened.created).toBe(false);
    expect(again.inserted).toEqual([]);
  });

  it('says the other person’s job title, client company and online state in the list (C5)', async () => {
    const { svc } = service({ [ME]: internal(ME), 'user-b': internal('user-b') }, pair);
    const [view] = await svc.list(context, principal('internal', 'member'));
    expect(view).toMatchObject({
      otherUserId: 'user-b',
      otherDisplayName: 'Bea',
      otherJobTitle: 'Art director',
      otherClientCompanyName: 'Acme Ltd',
      otherOnline: true,
    });
  });

  it('names the caller in the list answer so New message can leave them out (C5)', async () => {
    const { svc } = service({ [ME]: internal(ME), 'user-b': internal('user-b') }, pair);
    const answer = await new DirectConversationsController(svc).list(
      context,
      principal('internal', 'member'),
    );
    expect(answer.viewerUserId).toBe(ME);
    expect(answer.conversations.map((row) => row.otherUserId)).toEqual(['user-b']);
  });

  it('refuses a client messaging someone outside their projects with 404, writing nothing', async () => {
    const { svc, inserted } = service(
      { [ME]: client(ME, 'c1', ['p1']), 'user-b': internal('user-b', ['p9']) },
      null,
    );
    await expect(
      svc.open(context, principal('client', 'client_member'), 'user-b'),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(inserted).toEqual([]);
  });

  it('refuses an internal guest opening a conversation (no conversation.write)', async () => {
    const { svc } = service({ [ME]: internal(ME), 'user-b': internal('user-b') }, null);
    await expect(svc.open(context, principal('internal', 'guest'), 'user-b')).rejects.toMatchObject(
      {
        status: 403,
      },
    );
  });
});

describe('MentionCandidatesService', () => {
  it('gates on the channel, then dedupes, drops the caller and returns @<id> tokens', async () => {
    const repository = {
      search: async () => [
        { userId: 'user-b', displayName: 'Bea' },
        { userId: ME, displayName: 'Ann' },
        { userId: 'user-b', displayName: 'Bea' },
      ],
    } as unknown as MentionCandidatesRepository;
    const svc = new MentionCandidatesService(
      database,
      { get: async () => ({}) as never },
      repository,
    );
    const result = await svc.search(context, principal('internal', 'member'), 'conv-1', 'b');
    expect(result).toEqual([{ userId: 'user-b', displayName: 'Bea', mention: '@user-b' }]);

    const refusing = new MentionCandidatesService(
      database,
      {
        get: async () => {
          throw Object.assign(new Error('nf'), { status: 404 });
        },
      },
      repository,
    );
    await expect(
      refusing.search(context, principal('internal', 'member'), 'c', 'b'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('DirectConversationsRepository on conversations storage (R7)', () => {
  it('opens a kind=direct conversation with both people, and appends through messages', async () => {
    const created: unknown[] = [];
    const members: string[] = [];
    const conversations = Object.assign(new ConversationsRepository(), {
      create: async (_r: unknown, _c: unknown, input: unknown) => created.push(input),
      addMember: async (_r: unknown, _c: unknown, _id: string, userId: string) =>
        members.push(userId),
      appendMessage: async () => {
        throw new DuplicateMessageError('k');
      },
    });
    const repo = Object.assign(new DirectConversationsRepository(conversations), {
      findById: async () => ({ id: 'dm-1' }),
    });
    const { created: isNew } = await repo.insertPair({} as never, context, ME, 'user-b');
    expect(isNew).toBe(true);
    expect(created[0]).toMatchObject({ kind: 'direct', projectId: null, directUserLowId: ME });
    expect(members).toEqual([ME, 'user-b']);
    await expect(
      repo.appendMessage({} as never, context, {
        directConversationId: 'dm-1',
        body: 'x',
        clientGeneratedId: 'k',
      }),
    ).rejects.toBeInstanceOf(DuplicateDirectMessageError);
  });
});
