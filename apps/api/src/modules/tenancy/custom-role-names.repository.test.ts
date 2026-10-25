import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import {
  CustomRoleNamesRepository,
  customRoleIdsAmong,
  customRoleSummaryOf,
} from './custom-role-names.repository.js';

/**
 * H1 — custom role names for the People list and the organization switcher. The statement Drizzle
 * builds is handed to the production tenant guard, so an unscoped read of `custom_roles` fails here.
 */

const ORG = uuidv7();
const OTHER_ORG = uuidv7();
const ROLE_ID = '0192a8f0-0000-7000-8000-00000000c0de';

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

function capturingRunner(
  captured: { sql: string; params: readonly unknown[] }[],
  rows: readonly unknown[][],
): TenantQueryRunner {
  const respond = ((sql: string, params: readonly unknown[]) => {
    captured.push({ sql, params });
    return Promise.resolve(rows);
  }) as unknown as TenantQueryRunner['query'];
  return {
    query: respond,
    execute: respond as unknown as TenantQueryRunner['execute'],
    unscoped: () => ({
      query: respond,
      execute: respond as unknown as TenantQueryRunner['execute'],
    }),
  } as TenantQueryRunner;
}

describe('customRoleIdsAmong', () => {
  it('keeps only well-formed custom ids, lowercased once each', () => {
    expect(customRoleIdsAmong(['owner', ROLE_ID, ROLE_ID.toUpperCase(), 'nonsense'])).toEqual([
      ROLE_ID,
    ]);
  });
});

describe('CustomRoleNamesRepository.describe', () => {
  it('reads nothing when every role is built in', async () => {
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const names = await new CustomRoleNamesRepository().describe(
      capturingRunner(captured, []),
      contextFor(ORG),
      ['owner', 'member'],
    );
    expect(names.size).toBe(0);
    expect(captured).toEqual([]);
  });

  it('names the role with its allowlisted set, in a statement the tenant guard accepts', async () => {
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const names = await new CustomRoleNamesRepository().describe(
      capturingRunner(captured, [[ROLE_ID, 'Night editor', '["work.read","superpower"]']]),
      contextFor(ORG),
      [ROLE_ID, 'member'],
    );
    expect(customRoleSummaryOf(names, ROLE_ID.toUpperCase())).toEqual({
      name: 'Night editor',
      capabilities: ['work.read'],
    });
    expect(customRoleSummaryOf(names, 'member')).toBeUndefined();

    const statement = captured[0];
    expect(statement?.params).toContain(ORG);
    expect(statement?.sql).not.toContain(ORG);
    const analysis = analyzeStatement(statement?.sql ?? '', statement?.params ?? [], ORG);
    expect(analysis.violations, analysis.violations.join('\n')).toEqual([]);
    expect(analysis.tenantTables).toContain('custom_roles');
    expect(
      analyzeStatement(statement?.sql ?? '', statement?.params ?? [], OTHER_ORG).violations.length,
    ).toBeGreaterThan(0);
  });
});
