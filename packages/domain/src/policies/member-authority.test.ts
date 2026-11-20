import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitySetFor } from './capabilities.js';
import type { Capability } from './capabilities.js';
import {
  mayActOnMember,
  memberAuthorityTier,
  rosterScopeFor,
  seesRosterAdminFields,
} from './member-authority.js';

const tierOf = (role: string) => memberAuthorityTier(role, capabilitySetFor(role));

describe('member authority (QA-FIX-P S3)', () => {
  it('ranks owner, admin (org.manage) and everyone else', () => {
    expect(tierOf('owner')).toBe('owner');
    expect(tierOf('platform_support')).toBe('owner');
    expect(tierOf('org_admin')).toBe('admin');
    for (const role of ['workspace_admin', 'manager', 'moderator', 'member', 'guest']) {
      expect(tierOf(role)).toBe('member');
    }
  });

  it('reads a custom role by what it holds, not by its name', () => {
    const custom = '0199aa00-0000-7000-8000-0000000000f1';
    expect(memberAuthorityTier(custom, ['org.manage' as Capability])).toBe('admin');
    expect(memberAuthorityTier(custom, ['work.read' as Capability])).toBe('member');
    expect(memberAuthorityTier(custom, [])).toBe('member');
  });

  it('S3: an admin can act on neither the owner nor another admin', () => {
    expect(mayActOnMember('admin', 'owner')).toBe(false);
    expect(mayActOnMember('admin', 'admin')).toBe(false);
    expect(mayActOnMember('admin', 'member')).toBe(true);
  });

  it('an owner can act on anyone, a plain member on no one', () => {
    expect(mayActOnMember('owner', 'owner')).toBe(true);
    expect(mayActOnMember('owner', 'admin')).toBe(true);
    expect(mayActOnMember('member', 'member')).toBe(false);
    expect(mayActOnMember('member', 'admin')).toBe(false);
  });
});

describe('roster visibility (QA-FIX-P S2, ADR-0014)', () => {
  it('scopes only a guest to shared projects', () => {
    expect(rosterScopeFor('guest')).toBe('shared_projects');
    expect(rosterScopeFor('member')).toBe('organization');
    expect(rosterScopeFor('owner')).toBe('organization');
  });

  it('gives the admin fields only to someone holding org.manage', () => {
    expect(seesRosterAdminFields(capabilitySetFor('member'))).toBe(false);
    expect(seesRosterAdminFields(capabilitySetFor('manager'))).toBe(false);
    expect(seesRosterAdminFields(capabilitySetFor('org_admin'))).toBe(true);
    expect(seesRosterAdminFields(CAPABILITIES)).toBe(true);
  });
});
