import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PrincipalRepository } from '../tenancy/principal.repository.js';
import type { PolicySimulateReads } from './policy-simulate.repository.js';
import { clientCeilingWarnings, PolicySimulateService } from './policy-simulate.service.js';

/** 56-28 — the simulator warns when a client principal's effective set holds an internal capability. */
const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000c1';
const owner: Principal = {
  ...{ userId: USER, organizationId: ORG, kind: 'internal', role: 'owner' },
  ...{ membershipId: USER, membershipStatus: 'active', clientOrganizationId: null },
  ...{ projectIds: [], hasOrgWideScope: true },
};
const context = { organizationId: ORG, userId: USER, correlationId: USER } as TenantContext;

describe('56-28 policy simulator client-ceiling warning', () => {
  it('warns for a client custom role carrying project.manage, never for an internal one', () => {
    const key = customRoleKey('0199aa00-0000-7000-8000-0000000000f1', [
      'client_projection.read',
      'project.manage',
    ]);
    expect(clientCeilingWarnings('client', key)).toEqual([
      { code: 'client_internal_capability', capability: 'project.manage' },
    ]);
    expect(clientCeilingWarnings('internal', key)).toEqual([]);
  });

  it('a built-in client member simulates with no warning', async () => {
    const reads: PolicySimulateReads = {
      organizationExists: async () => true,
      findMember: async () => ({
        ...{ userId: USER, role: 'client_member', status: 'active' },
        ...{ hasOrgWideScope: false, workspaceScopeId: null },
      }),
    };
    const principals = { projectScope: async () => [] } as unknown as PrincipalRepository;
    const view = await new PolicySimulateService(reads, principals).simulate(
      {} as TenantQueryRunner,
      context,
      owner,
      { memberId: USER, capability: 'approval.read' },
    );
    expect(view.result.warnings).toEqual([]);
  });
});
