import { parseMembershipKind } from './kind.js';

/**
 * 60-01 (plan 60 v2 §4.1, §4.7, §5 test 1). The doors an AI employee may never pass.
 *
 * An AI employee is a member without credentials of its own: it works only through an agent key
 * or an OAuth grant its sponsor binds (60-05), and only through the agent contract (60-06). Every
 * door below refuses a membership whose kind is `ai` — and, deny by default, a membership whose
 * stored kind cannot be read. 60-04 wires each door to {@link mayPassDoor}; this list is the one
 * place the set is decided (AR-8).
 *
 * Pure: no I/O, no clock.
 */
export const AI_REFUSED_DOORS = [
  /** Password, passkey or e-mail-code sign-in. */
  'sign_in',
  'password_reset',
  'invitation_accept',
  'sso',
  'scim',
  'google_sign_in',
  'microsoft_sign_in',
  'portal_sign_in',
  /** A role change to any role {@link aiRoleDecision} refuses, one member or in bulk. */
  'admin_role',
  /** An approval step's approver or a deliverable's reviewer. */
  'approver',
  /** The human supervisor of an AI assignment. */
  'supervisor',
  /** The human who answers for an AI employee. */
  'sponsor',
  /** A client contact or a portal person. */
  'client_contact',
  /** Assigning work to another AI employee (AI-to-AI delegation, §9). */
  'assigner',
] as const;

export type AiRefusedDoor = (typeof AI_REFUSED_DOORS)[number];

/**
 * May a membership of this stored kind pass this door? Only an exact `human` passes; `ai` and an
 * unreadable kind are refused.
 */
export function mayPassDoor(kind: unknown, door: AiRefusedDoor): boolean {
  void door;
  return parseMembershipKind(kind) === 'human';
}
