/**
 * AI action details — tenancy (org invitations, org settings, workspaces).
 *
 * Slice S4 (registry wave C). The accept/register/preview invitation routes and org creation are
 * in `NEVER` (plan §2); this file covers only the org-scoped management surface. Role and policy
 * *definitions*, IP allowlist and security settings stay in `NEVER` too, so none appear here.
 */
import { z } from 'zod';
import {
  det,
  queryArgs,
  listArgs,
  pathOnly,
  bodyArgs,
  noArgs,
  f,
  type AiActionDetail,
} from './detail.js';
import { INVITATION_STATUSES } from '../../tenancy/invitations.repository.js';

/** `status` on the invitations list: a comma list of the statuses the controller accepts. */
const INVITATION_STATUS = INVITATION_STATUSES.join('|');
const INVITATION_STATUS_LIST = new RegExp(
  String.raw`^(${INVITATION_STATUS})(\s*,\s*(${INVITATION_STATUS}))*$`,
);

export const tenancyDetails: readonly AiActionDetail[] = [
  det({
    id: 'invitations.list',
    title: 'List invitations',
    description:
      'Invitations sent to join the workspace. Filter with status, a comma list of pending, accepted, expired, revoked.',
    input: queryArgs([], {
      status: z
        .string()
        .max(60)
        .regex(INVITATION_STATUS_LIST, 'a comma list of pending, accepted, expired, revoked')
        .optional(),
    }),
    redact: 'standard',
    examples: [{ summary: 'Pending only', args: { status: 'pending' } }],
  }),
  det({
    id: 'invitations.create',
    title: 'Invite someone to the workspace',
    description:
      'Send an email invitation to join in a role. Confirm-class: it emails a person. ' +
      'An employee or teammate: role "member" and no clientOrganizationId (as the People page ' +
      '"Invite person"). A client: role "client_reviewer" (or "client_admin") and the ' +
      'clientOrganizationId of an existing client company from client_organizations.list (as ' +
      '"Invite client"). projectIds: projects to share; note: an optional personal note.',
    // The body of `POST …/invitations` (invitations.controller.ts `issue`): projectIds are at
    // most 36-character ids, the note at most 500 characters (`MAX_INVITATION_NOTE_LENGTH`).
    input: bodyArgs([], {
      email: f.shortText(254),
      role: f.shortText(40),
      clientOrganizationId: f.id().nullish(),
      projectIds: z.array(f.id(36)).max(50).optional(),
      note: f.text(500).nullish(),
    }),
    redact: 'standard',
    notifies: true,
    examples: [
      { summary: 'Invite a member', args: { email: 'sam@example.com', role: 'member' } },
      {
        summary: 'Invite a client',
        args: {
          email: 'lee@client.example',
          role: 'client_reviewer',
          clientOrganizationId: 'co_1',
        },
      },
    ],
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
  // A11: the Organization settings card — name and logo.
  det({
    id: 'settings.organization.get',
    title: 'Read the organization profile',
    description: 'The organization name and the file id of its logo (null when none is set).',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Profile', args: {} }],
  }),
  det({
    id: 'settings.organization.update',
    title: 'Rename the organization',
    description:
      'Change the organization name shown in the app, in emails and in the client portal.',
    input: bodyArgs([], { name: f.shortText(190) }),
    redact: 'standard',
    examples: [{ summary: 'Rename', args: { name: 'Northstar Studio' } }],
  }),
  det({
    id: 'settings.logo.set',
    title: 'Set the organization logo',
    description: 'Use an uploaded org_logo file as the organization logo.',
    input: bodyArgs([], { fileId: f.id() }),
    redact: 'standard',
    examples: [{ summary: 'Set logo', args: { fileId: 'file_1' } }],
  }),
  det({
    id: 'settings.logo.delete',
    title: 'Remove the organization logo',
    description: 'Go back to the initials. Confirm-class.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: {} }],
  }),
  // B3: downloads before a virus scan — the company owner's choice.
  det({
    id: 'settings.download_scan_policy.get',
    title: 'Read the downloads-before-scan policy',
    description:
      'Whether files may be downloaded before the virus scan (allow_labeled or block), the effective value and whether a scanner is configured.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Policy', args: {} }],
  }),
  det({
    id: 'settings.download_scan_policy.update',
    title: 'Change the downloads-before-scan policy',
    description:
      'Owner only. allow_labeled serves unscanned files labelled not_scanned; block refuses them until scanned. Confirm-class.',
    input: bodyArgs([], { downloadsBeforeScan: z.enum(['allow_labeled', 'block']) }),
    redact: 'standard',
    examples: [{ summary: 'Block', args: { downloadsBeforeScan: 'block' } }],
  }),
  // C6 (0229): the company logo, organization-scoped.
  det({
    id: 'settings.logo_image.info',
    title: 'Read whether a company logo is set',
    description: 'The logo type, size and version, or null when the initials are shown.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Logo', args: {} }],
  }),
  det({
    id: 'settings.logo_image.get',
    title: 'Fetch the company logo image',
    description:
      'The logo image bytes (PNG, JPEG, WebP or sanitised SVG). Ask settings.logo_image.info first: it says null when there is no logo, and then this answers not found.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Image', args: {} }],
  }),
  det({
    id: 'settings.logo_image.upload',
    title: 'Upload the company logo',
    description:
      'A PNG, JPEG, WebP or SVG of at most 512 KB, as base64. An SVG is stored only after the server removes scripts, event handlers and external references.',
    input: bodyArgs([], {
      mimeType: f.shortText(150),
      dataBase64: z.string().min(4).max(700_000),
    }),
    redact: 'standard',
    examples: [{ summary: 'PNG', args: { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' } }],
  }),
  det({
    id: 'settings.logo_image.delete',
    title: 'Remove the company logo',
    description: 'Go back to the initials. Confirm-class.',
    input: noArgs(),
    redact: 'standard',
    examples: [{ summary: 'Remove', args: {} }],
  }),
  det({
    id: 'members.password_reset.create',
    title: 'Send a member a password reset link',
    description:
      'Email one active member the ordinary single-use 30-minute reset link, with a reason. Never yourself. Confirm-class: it emails a person.',
    input: bodyArgs(['membershipId'], { reason: f.shortText(500) }),
    redact: 'standard',
    notifies: true,
    examples: [
      {
        summary: 'Reset',
        args: { membershipId: 'm_1', reason: 'Locked out after a phone change' },
      },
    ],
  }),
  det({
    id: 'workspaces.list',
    title: 'List sub-workspaces',
    description: 'The workspaces (spaces) inside this organization.',
    input: listArgs([], {}, { cursor: 'after' }),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
];

/** The settings value is a scalar the API coerces (string, number or boolean). */
function z_value() {
  return f.shortText(2000).or(f.int(-1_000_000, 1_000_000)).or(f.bool());
}
