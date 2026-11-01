import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { assertTenantScoped } from '../../common/database/tenant-guard.js';
import { ClientFileReachRepository } from './client-file-reach.repository.js';

/**
 * R4 slice 4 — the client-reach reads without a server. Every statement the real Drizzle proxy
 * builds goes through the tenant guard in `enforce` mode, so each case also proves the SQL names
 * the active tenant on every table it touches.
 */

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const ORG = uuidv7();
const context: TenantContext = createTenantContext({
  organizationId: ORG,
  userId: uuidv7(),
  principalKind: 'client',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'test',
  correlationId: uuidv7(),
});

function fakeRunner(answers: readonly unknown[]): {
  runner: TenantQueryRunner;
  statements: Statement[];
} {
  const statements: Statement[] = [];
  let next = 0;
  const respond = (async (sql: string, params: readonly unknown[] = []) => {
    statements.push({ sql, params });
    assertTenantScoped(sql, params, context, { mode: 'enforce' });
    const answer = answers[next] ?? [];
    next += 1;
    return answer;
  }) as unknown as TenantQueryRunner['query'];
  const execute = respond as unknown as TenantQueryRunner['execute'];
  return {
    runner: { query: respond, execute, unscoped: () => ({ query: respond, execute }) },
    statements,
  };
}

const repository = new ClientFileReachRepository();

describe('ClientFileReachRepository', () => {
  it('finds a published deliverable version by its file, joined tenant-pair to its projection', async () => {
    const versionId = uuidv7();
    const projectId = uuidv7();
    const { runner, statements } = fakeRunner([[[versionId, projectId]]]);
    const found = await repository.publishedVersionNaming(runner, context, uuidv7());
    expect(found).toEqual({ deliverableVersionId: versionId, projectId });
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('`deliverable_versions`');
    expect(sql).toMatch(/inner join `client_projections`/i);
    expect(sql).toContain(
      '`client_projections`.`organization_id` = `deliverable_versions`.`organization_id`',
    );
  });

  it('answers null when no published version names the file', async () => {
    const { runner } = fakeRunner([[]]);
    expect(await repository.publishedVersionNaming(runner, context, uuidv7())).toBeNull();
  });

  it('says whether a deliverable has any projection', async () => {
    const yes = fakeRunner([[[uuidv7()]]]);
    expect(await repository.deliverableIsPublished(yes.runner, context, uuidv7())).toBe(true);
    const no = fakeRunner([[]]);
    expect(await repository.deliverableIsPublished(no.runner, context, uuidv7())).toBe(false);
  });

  it('answers no siblings, and one statement, for a file in no chain', async () => {
    const { runner, statements } = fakeRunner([[]]);
    expect(await repository.chainSiblings(runner, context, uuidv7())).toEqual([]);
    expect(statements).toHaveLength(1);
  });

  it('reads the chain from its root and loads the other members tenant-scoped', async () => {
    const root = uuidv7();
    const named = uuidv7();
    const other = uuidv7();
    const { runner, statements } = fakeRunner([[[root]], [[named], [other]], []]);
    await repository.chainSiblings(runner, context, named);
    expect(statements).toHaveLength(3);
    const load = statements[2];
    expect(load?.sql).toContain('`file_assets`');
    // The named asset itself is not asked for; the root and the other version are.
    expect(load?.params).toContain(root);
    expect(load?.params).toContain(other);
    expect(load?.params).not.toContain(named);
  });
});
