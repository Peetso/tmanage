/**
 * AI action details — tenancy (org invitations, org settings, workspaces).
 *
 * Slice S4 (registry wave C). The accept/register/preview invitation routes and org creation are
 * in `NEVER` (plan §2); this file covers only the org-scoped management surface. Role and policy
 * *definitions*, IP allowlist and security settings stay in `NEVER` too, so none appear here.
 */
import { det, listArgs, pathOnly, bodyArgs, noArgs, f, type AiActionDetail } from './detail.js';

export const tenancyDetails: readonly AiActionDetail[] = [
  det({
    id: 'invitations.list',
    title: 'List pending invitations',
    description: 'Invitations that have been sent but not yet accepted.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All pending', args: {} }],
  }),
  det({
    id: 'invitations.create',
    title: 'Invite someone to the workspace',
    description: 'Send an email invitation to join in a role. Confirm-class: it emails a person.',
    input: bodyArgs([], {
      email: f.shortText(254),
      role: f.shortText(40),
      clientOrganizationId: f.id().nullish(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Invite a member', args: { email: 'sam@example.com', role: 'member' } }],
  }),
  det({
    id: 'invitations.delete',
    title: 'Revoke an invitation',
    description: 'Cancel a pending invitation. Confirm-class.',
    input: pathOnly('invitationId'),
    redact: 'standard',
    examples: [{ summary: 'Revoke', args: { invitationId: 'inv_1' } }],
  }),
  det({
    id: 'invitations.reissues.create',
    title: 'Resend an invitation',
    description:
      'Re-send an invitation email, optionally changing the role. Confirm-class: it emails.',
    input: bodyArgs(['invitationId'], { role: f.shortText(40).optional() }),
    redact: 'standard',
    notifies: true,
    examples: [{ summary: 'Resend', args: { invitationId: 'inv_1' } }],
  }),
  det({
    id: 'invitations.expirations.create',
    title: 'Expire stale invitations',
    description: 'Mark overdue invitations as expired. Confirm-class.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Sweep', args: {} }],
  }),
  det({
    id: 'settings.list',
    title: 'Read workspace settings',
    description: 'Every allowlisted organization setting with its value or default.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'All settings', args: {} }],
  }),
  det({
    id: 'settings.set',
    title: 'Change a workspace setting',
    description:
      'Set one allowlisted organization setting. Off-list keys and bad values are refused.',
    input: bodyArgs(['key'], { value: z_value() }),
    redact: 'standard',
    examples: [{ summary: 'Set a key', args: { key: 'work.default_view', value: 'board' } }],
  }),
  det({
    id: 'workspaces.list',
    title: 'List sub-workspaces',
    description: 'The workspaces (spaces) inside this organization.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
];

/** The settings value is a scalar the API coerces (string, number or boolean). */
function z_value() {
  return f.shortText(2000).or(f.int(-1_000_000, 1_000_000)).or(f.bool());
}
