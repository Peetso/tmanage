import { describe, expect, it } from 'vitest';
import type { Principal } from './authorize.js';
import { CAPABILITIES, customRoleKey } from './capabilities.js';
import { computeEffectivePermissions } from './effective-permissions.js';

/** platform-admin v2 · PA-01 — "what can this person do" (SPEC §3.3, screen D8). */

const ORG = '0199bb00-0000-7000-8000-0000000000c1';
const PROJECT = '0199bb00-0000-7000-8000-000000000101';
const OTHER_PROJECT = '0199bb00-0000-7000-8000-000000000102';

function person(over: Partial<Principal> = {}): Principal {
  return {
    userId: '0199bb00-0000-7000-8000-0000000000a1',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: '0199bb00-0000-7000-8000-0000000000b1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    ...over,
  };
}

function entry(view: ReturnType<typeof computeEffectivePermissions>, capability: string) {
  const found = view.find((e) => e.capability === capability);
  if (!found) throw new Error(`missing ${capability}`);
  return found;
}

describe('computeEffectivePermissions', () => {
  it('returns one entry per capability, in allowlist order', () => {
    const view = computeEffectivePermissions({ principal: person() });
    expect(view.map((e) => e.capability)).toEqual([...CAPABILITIES]);
  });

  it('names the role as the source of a granted capability and scopes by relation', () => {
    const view = computeEffectivePermissions({ principal: person(), project: { id: PROJECT } });
    expect(entry(view, 'work.read')).toEqual({
      capability: 'work.read',
      final: true,
      source: 'role',
      scope: 'projects',
    });
    expect(entry(view, 'org.manage')).toMatchObject({ final: false, source: 'not_in_ceiling' });
  });

  it('a project the person is not on leaves relation-gated capabilities off', () => {
    const view = computeEffectivePermissions({
      principal: person(),
      project: { id: OTHER_PROJECT },
    });
    expect(entry(view, 'work.read').final).toBe(false);
  });

  it('marks overrides as their own source', () => {
    const view = computeEffectivePermissions({
      principal: person({ overrides: { allow: ['report.export'], deny: ['decision.write'] } }),
    });
    expect(entry(view, 'report.export')).toMatchObject({ final: true, source: 'override_allow' });
    expect(entry(view, 'decision.write')).toMatchObject({ final: false, source: 'override_deny' });
  });

  it('marks a capability the organization switched off', () => {
    const view = computeEffectivePermissions({
      principal: person({ role: 'owner', hasOrgWideScope: true, projectIds: [] }),
      orgPolicy: { disabledCapabilities: ['ai.use'] },
    });
    expect(entry(view, 'ai.use')).toMatchObject({ final: false, source: 'org_policy_off' });
    expect(entry(view, 'org.manage')).toMatchObject({ final: true, source: 'role', scope: 'org' });
  });

  it('names a custom role as the source', () => {
    const role = customRoleKey('0199bb00-0000-7000-8000-0000000000f1', ['report.view']);
    const view = computeEffectivePermissions({
      principal: person({ role, hasOrgWideScope: true, projectIds: [] }),
    });
    expect(entry(view, 'report.view')).toMatchObject({ final: true, source: 'custom_role' });
  });

  it('a member reads only their own audit activity', () => {
    const view = computeEffectivePermissions({ principal: person() });
    expect(entry(view, 'audit.read').scope).toBe('own');
  });
});
