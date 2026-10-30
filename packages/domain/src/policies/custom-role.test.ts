import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  INTERNAL_ONLY_CAPABILITIES,
  capabilitiesFor,
  capabilitySetFor,
  customRoleIdOf,
  customRoleKey,
  hasCapability,
  isClientRole,
  isCustomRoleKey,
  parseCustomRoleCapabilities,
  type Capability,
  type PrincipalRole,
} from './capabilities.js';
import { authorize, mayGrantCapability, type Principal } from './authorize.js';

/** L1 — a custom role principal holds exactly its allowlisted set, and nothing widens it. */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const ROLE_ID = '0199aa00-0000-7000-8000-0000000000f1';

function principal(role: PrincipalRole, kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: '0199aa00-0000-7000-8000-0000000000a1',
    organizationId: ORG,
    kind,
    role,
    membershipId: '0199aa00-0000-7000-8000-0000000000b1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? '0199aa00-0000-7000-8000-0000000000d1' : null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

const resource = { organizationId: ORG, projectId: null, audience: 'internal' } as const;

function allowedFor(subject: Principal): Capability[] {
  return CAPABILITIES.filter(
    (capability) => authorize({ principal: subject, capability, resource }).allowed,
  );
}

describe('custom role keys', () => {
  it('carry exactly the allowlisted capabilities they were built from', () => {
    const key = customRoleKey(ROLE_ID, ['work.read', 'org.manage', 'members.manage', 'nope']);
    expect(isCustomRoleKey(key)).toBe(true);
    expect(customRoleIdOf(key)).toBe(ROLE_ID);
    expect([...capabilitiesFor(key)].sort()).toEqual(['org.manage', 'work.read']);
    expect(hasCapability(key, 'work.read')).toBe(true);
    expect(hasCapability(key, 'work.create')).toBe(false);
    expect(isClientRole(key)).toBe(false);
  });

  it('round-trips every capability, and the empty set', () => {
    expect(capabilitiesFor(customRoleKey(ROLE_ID, CAPABILITIES))).toEqual([...CAPABILITIES]);
    expect(capabilitiesFor(customRoleKey(ROLE_ID, []))).toEqual([]);
  });

  it('a raw custom role id, a malformed key or a forged mask holds nothing', () => {
    expect(capabilitySetFor(ROLE_ID).size).toBe(0);
    expect(capabilitySetFor(`custom:${ROLE_ID}:zz`).size).toBe(0);
    expect(capabilitySetFor(`custom:not-a-uuid:${'f'.repeat(10)}`).size).toBe(0);
    expect(customRoleIdOf('owner')).toBeNull();
    expect(() => customRoleKey('Not-A-Uuid', [])).toThrow();
  });

  it('parses stored JSON defensively', () => {
    expect(parseCustomRoleCapabilities('["work.read","x",3,"work.read"]')).toEqual(['work.read']);
    expect(parseCustomRoleCapabilities('{"work.read":true}')).toEqual([]);
    expect(parseCustomRoleCapabilities('not json')).toEqual([]);
  });
});

describe('authorize with a custom role', () => {
  it('allows exactly the custom set (member management via org.manage, nothing more)', () => {
    expect(allowedFor(principal(customRoleKey(ROLE_ID, ['org.manage'])))).toEqual(['org.manage']);
  });

  it('allows a mixed set and denies everything outside it', () => {
    const subject = principal(customRoleKey(ROLE_ID, ['work.read', 'file.download']));
    expect(allowedFor(subject)).toEqual(['work.read', 'file.download']);
    expect(authorize({ principal: subject, capability: 'org.manage', resource })).toMatchObject({
      allowed: false,
      code: 'capability_not_in_role_ceiling',
      detail: 'role custom role does not include org.manage',
    });
  });

  it('never widens internal-only capabilities to a client principal, even with a custom set', () => {
    const subject = principal(customRoleKey(ROLE_ID, CAPABILITIES), 'client');
    const allowed = allowedFor(subject);
    for (const capability of INTERNAL_ONLY_CAPABILITIES) {
      expect(allowed).not.toContain(capability);
    }
  });

  it('a custom role grants only what it holds, and never acts as the owner', () => {
    const subject = principal(customRoleKey(ROLE_ID, ['org.manage', 'approval.decide']));
    expect(mayGrantCapability(subject, 'org.manage', ORG).allowed).toBe(true);
    expect(mayGrantCapability(subject, 'work.read', ORG).allowed).toBe(false);
    // The reviewer relation is taken as held only for the built-in owner.
    expect(mayGrantCapability(subject, 'approval.decide', ORG).allowed).toBe(false);
  });
});

// ---- platform-admin v2 · PA-01 ----
describe('custom role masks after the 24 new capabilities', () => {
  it('the allowlist has 58 capabilities and a mask round-trips every one of them', () => {
    expect(CAPABILITIES).toHaveLength(58);
    const key = customRoleKey(ROLE_ID, CAPABILITIES);
    expect(customRoleIdOf(key)).toBe(ROLE_ID);
    expect([...capabilitySetFor(key)].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('a role stored before the new capabilities is rebuilt with exactly its old set', () => {
    const old = ['work.read', 'work.create', 'org.manage'];
    const key = customRoleKey(ROLE_ID, parseCustomRoleCapabilities(JSON.stringify(old)));
    expect([...capabilitySetFor(key)].sort()).toEqual([...old].sort());
    expect(hasCapability(key, 'roles.assign')).toBe(false);
  });

  it('a new capability in a stored role is honoured and unknown strings are dropped', () => {
    const json = JSON.stringify(['decision.read', 'report.export', 'not.a.capability']);
    expect(parseCustomRoleCapabilities(json)).toEqual(['decision.read', 'report.export']);
    const key = customRoleKey(ROLE_ID, parseCustomRoleCapabilities(json));
    expect(hasCapability(key, 'report.export')).toBe(true);
  });
});
