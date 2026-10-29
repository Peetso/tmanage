import { describe, expect, it } from 'vitest';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ResolvedMembership } from './membership-resolver.repository.js';
import { defaultOrgWideScope, PrincipalRepository, principalFor } from './principal.repository.js';

/**
 * x65 item B1 (carried from review-x59 Minor). `projectScope`'s workspace-scope branch (0023 /
 * TEN-001) had no pure unit test — only the DB suite exercised it. These fix the two internal
 * scope decisions without a server: a Workspace Admin's non-null `workspaceScopeId` widens their
 * reach to every project in that one workspace (anchored on `organization_id`, never crossing the
 * tenant), and the default — a null `workspaceScopeId` — falls through to the narrower
 * project-membership scope. A fake runner captures the SQL Drizzle emits so the branch taken is
 * proven, not assumed.
 */

const ORG_ID = '018f0000-0000-7000-8000-0000000000a1';
const USER_ID = '018f0000-0000-7000-8000-0000000000b2';
const MEMBERSHIP_ID = '018f0000-0000-7000-8000-0000000000c3';
const CORRELATION_ID = '018f0000-0000-7000-8000-0000000000d4';
const WORKSPACE_ID = '018f0000-0000-7000-8000-0000000000e5';

function internalContext(): TenantContext {
  return createTenantContext({
    organizationId: ORG_ID,
    userId: USER_ID,
    principalKind: 'internal',
    membershipId: MEMBERSHIP_ID,
    capabilities: [],
    policyVersion: 'v2:1:1',
    correlationId: CORRELATION_ID,
  });
}

function resolvedFor(context: TenantContext, workspaceScopeId: string | null): ResolvedMembership {
  return {
    context,
    role: 'workspace_admin',
    clientOrganizationId: null,
    hasOrgWideScope: false,
    workspaceScopeId,
  };
}

/**
 * A runner that answers every `query` with the supplied positional rows and records the SQL it
 * was asked to run. `tenantDrizzle` calls `runner.query(sql, params, { rowsAsArray: true })`, so a
 * single-column select decodes each `[value]` row into `{ projectId: value }`.
 */
function recordingRunner(rows: readonly (readonly unknown[])[]): {
  runner: TenantQueryRunner;
  statements: string[];
} {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => {
      statements.push(sql);
      return rows as unknown as never;
    },
  } as unknown as TenantQueryRunner;
  return { runner, statements };
}

describe('PrincipalRepository.projectScope — workspace scope (0023)', () => {
  it('widens a non-org-wide workspace admin to every project in their workspace', async () => {
    const context = internalContext();
    const { runner, statements } = recordingRunner([['proj-1'], ['proj-2']]);

    const scope = await new PrincipalRepository().projectScope(
      runner,
      context,
      resolvedFor(context, WORKSPACE_ID),
    );

    expect(scope).toEqual(['proj-1', 'proj-2']);
    // The one statement is the workspace-projects read, anchored on organization_id and filtered
    // by workspace_id — the branch that grants the workspace, never the project-membership fallback.
    expect(statements).toHaveLength(1);
    const sql = statements[0]?.toLowerCase() ?? '';
    expect(sql).toContain('workspace_id');
    expect(sql).toContain('organization_id');
    expect(sql).not.toContain('project_memberships');
  });

  it('falls through to project-membership scope when the workspace scope is the default null', async () => {
    const context = internalContext();
    const { runner, statements } = recordingRunner([['proj-9']]);

    const scope = await new PrincipalRepository().projectScope(
      runner,
      context,
      resolvedFor(context, null),
    );

    expect(scope).toEqual(['proj-9']);
    expect(statements).toHaveLength(1);
    expect(statements[0]?.toLowerCase() ?? '').toContain('project_memberships');
  });
});

// ---- platform-admin v2 · PA-01 ----
describe('principalFor — per-member overrides and TManage support (SPEC §3.3)', () => {
  it('carries the resolved overrides onto the principal', () => {
    const context = internalContext();
    const overrides = { allow: ['report.export'], deny: ['work.delete'] } as const;
    const principal = principalFor({ ...resolvedFor(context, null), overrides }, ['proj-1']);
    expect(principal.overrides).toEqual(overrides);
    expect(principal.projectIds).toEqual(['proj-1']);
  });

  it('leaves overrides absent when the resolver supplied none', () => {
    const principal = principalFor(resolvedFor(internalContext(), null), []);
    expect(principal).not.toHaveProperty('overrides');
  });

  it('gives TManage support organization-wide scope by default', () => {
    expect(defaultOrgWideScope('platform_support')).toBe(true);
    expect(defaultOrgWideScope('member')).toBe(false);
  });
});
