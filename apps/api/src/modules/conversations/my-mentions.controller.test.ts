import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MyMentionsService } from './my-mentions.service.js';
import { MyMentionsRepository } from './my-mentions.repository.js';
import type { MentionCandidateRow } from './my-mentions.repository.js';

/**
 * x254 relation gate: a mention is a mention *in a room the caller is in*.
 *
 * `conversation.read` is a ceiling — it says a member may read conversations, not *which* ones.
 * The service adds the relation: it keeps a candidate mention only when its channel is among the
 * caller's memberships. The load-bearing assertion below is that a message which mentions the
 * caller in a conversation they are **not** a member of is absent from the result, even though it
 * matched the token — the channel that could leak is not the caller's, so it is dropped.
 *
 * The fake repository models the split the real one has: {@link RecordingRepository.listMentionCandidates}
 * returns the org-wide token matches (the broad scan), while {@link RecordingRepository.listMemberConversationIds}
 * answers only the caller's own memberships (the gate's input). The service is what refuses.
 */

const ORG = '0198f254-0000-7000-8000-000000000001';
const USER = '0198f254-0000-7000-8000-0000000000a1';
const PROJECT = '0198f254-0000-7000-8000-000000000b01';
const MEMBER_CHANNEL = '0198f254-0000-7000-8000-000000000c01';
const FOREIGN_CHANNEL = '0198f254-0000-7000-8000-000000000c02';
const MSG_IN = '0198f254-0000-7000-8000-000000000d01';
const MSG_OUT = '0198f254-0000-7000-8000-000000000d02';

const CONTEXT = {
  organizationId: ORG,
  userId: USER,
  principalKind: 'internal',
  membershipId: '0198f254-0000-7000-8000-000000000e01',
  capabilities: [],
  policyVersion: '1',
  correlationId: '0198f254-0000-7000-8000-000000000f01',
} as unknown as TenantContext;

/** An internal member of PROJECT without org-wide scope — the relation rides on projectIds. */
const MEMBER: Principal = {
  userId: USER,
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: '0198f254-0000-7000-8000-000000000e01',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

function candidate(messageId: string, conversationId: string): MentionCandidateRow {
  return {
    messageId,
    conversationId,
    conversationName: conversationId === MEMBER_CHANNEL ? 'atlas-relaunch' : 'private-room',
    projectId: PROJECT,
    authorUserId: '0198f254-0000-7000-8000-0000000000a2',
    body: `heads up @${USER}`,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    archivedAt: null,
  };
}

/** Both channels match the token; only one is the caller's. */
class RecordingRepository extends MyMentionsRepository {
  override async listMemberConversationIds(): Promise<readonly string[]> {
    return [MEMBER_CHANNEL];
  }

  override async listMentionCandidates(): Promise<readonly MentionCandidateRow[]> {
    // Newest first, as the real query orders; the foreign channel's message is the newer one, so a
    // gate that only paged would surface it first.
    return [candidate(MSG_OUT, FOREIGN_CHANNEL), candidate(MSG_IN, MEMBER_CHANNEL)];
  }
}

function build(): MyMentionsService {
  const database = {
    read: <T>(_context: TenantContext, work: (db: unknown) => Promise<T>) => work({}),
    transaction: <T>(_context: TenantContext, work: (tx: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  return new MyMentionsService(database, new RecordingRepository());
}

describe('my mentions are scoped to the caller’s conversations', () => {
  it('excludes a mention in a conversation the caller is not a member of', async () => {
    const mentions = await build().listMyMentions(CONTEXT, MEMBER, { page: 1 });

    // The caller's own channel is present…
    expect(mentions.map((m) => m.messageId)).toContain(MSG_IN);
    // …and the mention in the room they are not in is gone, token match or not.
    expect(mentions.map((m) => m.messageId)).not.toContain(MSG_OUT);
    expect(mentions.map((m) => m.conversationId)).not.toContain(FOREIGN_CHANNEL);
  });

  it('rejects a non-positive page rather than returning a silent empty list', async () => {
    await expect(build().listMyMentions(CONTEXT, MEMBER, { page: 0 })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('F13: a stale channel row is not authority after a project removal', () => {
  it('drops a mention in a channel whose project the caller was removed from', async () => {
    // The caller still holds the (stale) MEMBER_CHANNEL row, but is no longer on PROJECT.
    const removed: Principal = { ...MEMBER, projectIds: [] };
    const mentions = await build().listMyMentions(CONTEXT, removed, { page: 1 });
    expect(mentions).toEqual([]);
  });

  it('lets an org-wide caller see a mention without a channel row, as mayReach does', async () => {
    const owner: Principal = { ...MEMBER, role: 'owner', projectIds: [], hasOrgWideScope: true };
    const mentions = await build().listMyMentions(CONTEXT, owner, { page: 1 });
    expect(mentions.map((m) => m.messageId)).toEqual([MSG_OUT, MSG_IN]);
  });
});
