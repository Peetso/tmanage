import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import { WorkItemsRepository } from './work-items.repository.js';

/**
 * 2026-11-24 — offboarding a person who led work items was refused by the tenant guard: the 0412
 * hand-over (`removeMember`) sets the owner from a correlated sub-select, and the guard read the
 * sub-select's `memberships.organization_id = work_item_assignees.organization_id` as an
 * assignment of the tenant key. No unit test ran that statement through the guard. These capture
 * every statement of the offboarding path exactly as Drizzle renders it and hand each to
 * `analyzeStatement`, the production guard (DA-12), so a statement it would refuse fails here.
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

function expectGuardAccepts(statement: Captured): void {
  const analysis = analyzeStatement(statement.sql, statement.params, ORG);
  expect(analysis.violations, `${statement.sql}\n${analysis.violations.join('\n')}`).toEqual([]);
}

describe('offboarding hand-over SQL passes the tenant guard', () => {
  it('removeMember: the membership lookup, the hand-over update and the row delete', async () => {
    const captured: Captured[] = [];
    const runner = scriptedRunner(captured, [
      [[uuidv7()]],
      { affectedRows: 2 },
      { affectedRows: 3 },
    ]);

    const changed = await new WorkItemAssigneesRepository().removeMember(
      runner,
      contextFor(ORG),
      uuidv7(),
      { liveOnly: true },
    );

    expect(changed).toBe(2);
    expect(captured).toHaveLength(3);
    expect(captured[1]?.sql).toMatch(/^update `work_items` set `owner_user_id` = \(select/i);
    for (const statement of captured) expectGuardAccepts(statement);
  });

  it('clearOwnerForUser (the offboarding caller): every statement it sends', async () => {
    const captured: Captured[] = [];
    const runner = scriptedRunner(captured, [
      [[uuidv7()]],
      { affectedRows: 1 },
      { affectedRows: 1 },
      { affectedRows: 4 },
    ]);

    const cleared = await new WorkItemsRepository().clearOwnerForUser(
      runner,
      contextFor(ORG),
      uuidv7(),
    );

    expect(cleared).toBe(5);
    expect(captured).toHaveLength(4);
    for (const statement of captured) expectGuardAccepts(statement);
  });
});
