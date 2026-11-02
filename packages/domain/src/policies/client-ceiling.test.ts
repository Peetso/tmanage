import { describe, expect, it } from 'vitest';
import { CLIENT_ROLES, capabilitiesFor, customRoleKey } from './capabilities.js';
import {
  CLIENT_CAPABILITY_ALLOWLIST,
  clientCeilingViolations,
  isInternalCapabilityForClient,
} from './client-ceiling.js';

/** 56-28 UNIT client-ceiling — no client role ceiling holds a capability outside the allowlist. */
describe('56-28 client ceiling', () => {
  it.each(CLIENT_ROLES)('%s has zero violations', (role) => {
    expect(clientCeilingViolations(role, capabilitiesFor(role))).toEqual([]);
  });

  it('detects a seeded violation, once, by its token', () => {
    const key = customRoleKey('0199aa00-0000-7000-8000-0000000000f1', [
      'client_projection.read',
      'project.manage',
    ]);
    expect(clientCeilingViolations(key)).toEqual(['project.manage']);
    expect(
      clientCeilingViolations('client_viewer', ['work.read', 'work.read', 'file.download']),
    ).toEqual(['work.read']);
    expect(isInternalCapabilityForClient('finance.view')).toBe(true);
    expect(CLIENT_CAPABILITY_ALLOWLIST.every((c) => !isInternalCapabilityForClient(c))).toBe(true);
  });
});
