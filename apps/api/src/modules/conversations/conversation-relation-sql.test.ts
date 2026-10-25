import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MentionCandidatesRepository } from './mention-candidates.repository.js';
import { MessageAttachmentsRepository } from './message-attachments.repository.js';
import { MessageBookmarksRepository } from './message-bookmarks.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { SearchIndexRepository } from '../search/search-index.repository.js';

/**
 * Security lane S10 — the SQL half of F13, F22 and F40, proved without a server. Each statement
 * Drizzle builds is captured off a scripted runner and (a) checked for the predicate the fix
 * adds and (b) handed to `analyzeStatement`, the production tenant guard, so a new join that
 * left a tenant table unanchored would fail here exactly as it would at runtime.
 */

const ORG = uuidv7();

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function contextFor(organizationId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId: uuidv7(),
    principalKind: 'internal',
    membershipId: uuidv7(),
    capabilities: [],
    policyVersion: 'test',
    correlationId: uuidv7(),
  });
}

/** Answers each statement in turn from `answers` (rows for a select, a header for a write). */
function scriptedRunner(captured: Captured[], answers: readonly unknown[]): TenantQueryRunner {
  let next = 0;
  const respond = ((sql: string, params: readonly unknown[]) => {
    captured.push({ sql, params });
    const answer = answers[next] ?? [];
    next += 1;
    return Promise.resolve(answer);
  }) as unknown as TenantQueryRunner['query'];
  return {
    query: respond,
    execute: respond as unknown as TenantQueryRunner['execute'],
    unscoped: () => ({
      query: respond,
      execute: respond as unknown as TenantQueryRunner['execute'],
    }),
  } as unknown as TenantQueryRunner;
}

function expectGuardAccepts(statement: Captured | undefined): void {
  expect(statement).toBeDefined();
  const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
  expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
}

describe('F13: project removal revokes the channel rows', () => {
  it('removes the person from every channel of the project (open and archived)', async () => {
    const captured: Captured[] = [];
    const userId = uuidv7();
    const projectId = uuidv7();
    const channel = uuidv7();
    const runner = scriptedRunner(captured, [[[channel]], { affectedRows: 1 }]);

    const removed = await new ConversationsRepository().removeMemberFromProjectChannels(
      runner,
      contextFor(ORG),
      projectId,
      userId,
    );

    expect(removed).toBe(1);
    const [select, remove] = captured;
    // The channel list is not narrowed to open channels: archived rooms are revoked too.
    expect(select?.sql).not.toMatch(/archived_at/i);
    expect(select?.params).toContain(projectId);
    expect(remove?.sql).toMatch(/^delete from `conversation_memberships`/i);
    expect(remove?.params).toEqual(expect.arrayContaining([ORG, userId, channel]));
    expectGuardAccepts(select);
    expectGuardAccepts(remove);
  });

  it('offboarding (removeAllForUser) also deletes every channel row of the person', async () => {
    const captured: Captured[] = [];
    const userId = uuidv7();
    const runner = scriptedRunner(captured, [{ affectedRows: 2 }, { affectedRows: 3 }]);

    const count = await new ProjectMembershipsRepository().removeAllForUser(
      runner,
      contextFor(ORG),
      userId,
    );

    expect(count).toBe(2);
    const channelDelete = captured.find((statement) =>
      /^delete from `conversation_memberships`/i.test(statement.sql),
    );
    expect(channelDelete?.params).toEqual(expect.arrayContaining([ORG, userId]));
    expectGuardAccepts(channelDelete);
  });

  it('mention candidates require a current project membership on the channel’s project', async () => {
    const captured: Captured[] = [];
    const runner = scriptedRunner(captured, [[], []]);
    await new MentionCandidatesRepository().search(runner, contextFor(ORG), uuidv7(), 'Sa', 10);
    const inChannel = captured[0];
    expect(inChannel?.sql).toMatch(/join `project_memberships`/i);
    expectGuardAccepts(inChannel);
  });

  it('saved messages carry the channel’s project for the per-row authorize', async () => {
    const captured: Captured[] = [];
    const runner = scriptedRunner(captured, [[]]);
    await new MessageBookmarksRepository().listMine(runner, contextFor(ORG), {
      userId: uuidv7(),
      hasOrgWideScope: false,
    });
    expect(captured[0]?.sql).toMatch(/join `conversations`/i);
    expectGuardAccepts(captured[0]);
  });
});

describe('F22: search narrows message hits by channel membership', () => {
  it('reads the caller’s channel rows for the hit channels in one tenant-scoped IN query', async () => {
    const captured: Captured[] = [];
    const member = uuidv7();
    const other = uuidv7();
    const runner = scriptedRunner(captured, [[[member]]]);
    const userId = uuidv7();

    const ids = await new SearchIndexRepository().listMemberConversationIds(
      runner,
      contextFor(ORG),
      userId,
      [member, other],
    );

    expect([...ids]).toEqual([member]);
    expect(captured[0]?.params).toEqual(expect.arrayContaining([ORG, userId, member, other]));
    expectGuardAccepts(captured[0]);
  });
});

describe('F40: a taken-down message lists no attachments in the batched read', () => {
  it('joins the live message (deleted_at is null)', async () => {
    const captured: Captured[] = [];
    const runner = scriptedRunner(captured, [[]]);
    await new MessageAttachmentsRepository().listForMessages(runner, contextFor(ORG), [uuidv7()]);
    expect(captured[0]?.sql).toMatch(/join `messages`/i);
    expect(captured[0]?.sql).toMatch(/`messages`\.`deleted_at` is null/i);
    expectGuardAccepts(captured[0]);
  });
});
