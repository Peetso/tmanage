import { describe, expect, it } from 'vitest';
import { customRoleKey, hasCapability } from '@tmanage/domain';
import { mayBeTold, mayClientDecide } from '../../consumers/collaboration-notices.js';
import { mayReadDirect } from './direct-message-store.js';
import type { WorkerDirectParty } from './direct-message-store.js';
import { checkConversationSubscription } from './realtime-store.js';
import { customRoleJoin, internalPrincipalRole, roleHolds } from './principal-role.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * H1 — custom-role members are no longer skipped by the worker's raw-row role checks. These pin
 * the resolution and each call-site group without a database; the join itself runs against real
 * rows in the database suites.
 */

const ROLE_ID = '0192a8f0-0000-7000-8000-00000000c0de';
const OTHER_ID = '0192a8f0-0000-7000-8000-00000000beef';
const chatRole = { custom_role_id: ROLE_ID, custom_role_capabilities: '["conversation.read"]' };
const workRole = { custom_role_id: ROLE_ID, custom_role_capabilities: '["work.read"]' };

describe('internalPrincipalRole', () => {
  it('keeps a built-in internal role as itself', () => {
    expect(internalPrincipalRole('member')).toBe('member');
  });

  it('turns a custom role id into a key holding exactly its stored set', () => {
    const role = internalPrincipalRole(ROLE_ID, chatRole);
    expect(role).toBe(customRoleKey(ROLE_ID, ['conversation.read']));
    expect(roleHolds(role, 'conversation.read')).toBe(true);
    expect(roleHolds(role, 'work.read')).toBe(false);
  });

  it('accepts an upper-case stored id, as the API resolver does', () => {
    expect(internalPrincipalRole(ROLE_ID.toUpperCase(), chatRole)).toBe(
      customRoleKey(ROLE_ID, ['conversation.read']),
    );
  });

  it('holds nothing when the joined row is missing or names another role', () => {
    expect(internalPrincipalRole(ROLE_ID)).toBeNull();
    expect(internalPrincipalRole(ROLE_ID, { custom_role_id: null })).toBeNull();
    expect(internalPrincipalRole(ROLE_ID, { ...chatRole, custom_role_id: OTHER_ID })).toBeNull();
  });

  it('drops capabilities off the allowlist and survives malformed JSON', () => {
    const forged = internalPrincipalRole(ROLE_ID, {
      custom_role_id: ROLE_ID,
      custom_role_capabilities: '["superpower","work.read"]',
    });
    expect(roleHolds(forged, 'work.read')).toBe(true);
    const broken = internalPrincipalRole(ROLE_ID, {
      custom_role_id: ROLE_ID,
      custom_role_capabilities: 'not json',
    });
    expect(broken).not.toBeNull();
    expect(roleHolds(broken, 'work.read')).toBe(false);
  });

  it('refuses a client role name on an internal row, an unknown name and a forged key', () => {
    expect(internalPrincipalRole('client_admin')).toBeNull();
    expect(internalPrincipalRole('superuser')).toBeNull();
    const forgedKey = customRoleKey(ROLE_ID, ['org.manage']);
    expect(hasCapability(forgedKey, 'org.manage')).toBe(true);
    expect(internalPrincipalRole(forgedKey, chatRole)).toBeNull();
    expect(internalPrincipalRole(null)).toBeNull();
  });

  it('joins the role row inside the membership organization only', () => {
    expect(customRoleJoin('m')).toContain('cr.organization_id = m.organization_id');
    expect(customRoleJoin('m')).toContain('cr.id = m.role');
  });
});

describe('realtime subscription (realtime-store)', () => {
  function txReturning(row: Record<string, unknown>): WorkerTransaction {
    return { query: async <T>(): Promise<T> => [row] as unknown as T };
  }
  const input = { organizationId: 'org-1', userId: 'user-1', conversationId: 'conv-1' } as const;
  const base = { role: ROLE_ID, next_sequence_no: 8, is_member: 1, may_reach_project: 1 };

  it('allows a custom-role member whose role reads conversations', async () => {
    const verdict = await checkConversationSubscription(
      txReturning({ ...base, ...chatRole, has_org_wide_scope: 0 }),
      input,
    );
    expect(verdict).toEqual({ allowed: true, cursor: 7 });
  });

  it('refuses a custom-role member whose role does not', async () => {
    const verdict = await checkConversationSubscription(
      txReturning({ ...base, ...workRole, has_org_wide_scope: 0 }),
      input,
    );
    expect(verdict.allowed).toBe(false);
  });
});

describe('direct messages (direct-message-store)', () => {
  function internal(userId: string, role: WorkerDirectParty['role']): WorkerDirectParty {
    return {
      userId,
      kind: 'internal',
      clientOrganizationIds: [],
      projectIds: [],
      role,
      membershipId: `m-${userId}`,
    };
  }

  it('lets a custom-role member with conversation.read read a DM, and not one without', () => {
    const other = internal('b', 'member');
    expect(mayReadDirect(internal('a', internalPrincipalRole(ROLE_ID, chatRole)), other)).toBe(
      true,
    );
    expect(mayReadDirect(internal('a', internalPrincipalRole(ROLE_ID, workRole)), other)).toBe(
      false,
    );
    expect(mayReadDirect(internal('a', null), other)).toBe(false);
  });
});

describe('collaboration notices (collaboration-notices)', () => {
  it('tells a custom-role member on the project when their role holds the capability', () => {
    const reach = {
      membershipId: 'm-1',
      role: internalPrincipalRole(ROLE_ID, workRole),
      hasOrgWideScope: false,
      onProject: true,
    };
    expect(mayBeTold(reach, 'work.read')).toBe(true);
    expect(mayBeTold(reach, 'conversation.read')).toBe(false);
    expect(mayBeTold({ ...reach, onProject: false }, 'work.read')).toBe(false);
    expect(mayBeTold({ ...reach, role: null }, 'work.read')).toBe(false);
  });

  it('asks only built-in client roles that may decide', () => {
    expect(mayClientDecide('client_reviewer')).toBe(true);
    expect(mayClientDecide('client_viewer')).toBe(false);
    expect(mayClientDecide('owner')).toBe(false);
    expect(mayClientDecide(ROLE_ID)).toBe(false);
  });
});
