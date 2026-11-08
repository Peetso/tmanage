import { describe, expect, it } from 'vitest';
import { invitationRoleName } from '../src/components/screens/AdminInvitationsView';

/** B11 — an invitation's role chip names the real role, never a generic "Custom role" for a known one. */
describe('invitationRoleName', () => {
  const custom = [{ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', name: 'QA Reviewer 07' }] as never;

  it('shows a custom role by name and a built-in or client role by its label', () => {
    expect(invitationRoleName('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', custom, 'Custom role')).toBe(
      'QA Reviewer 07',
    );
    expect(invitationRoleName('member', custom, 'Custom role')).toBe('Team member');
    expect(invitationRoleName('client_viewer', custom, 'Custom role')).toBe('Client viewer');
    expect(invitationRoleName('0190ffff-0000-7000-8000-000000000000', [], 'Custom role')).toBe(
      'Custom role',
    );
  });
});
