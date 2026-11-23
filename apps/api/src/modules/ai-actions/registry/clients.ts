/**
 * AI action details — clients (client organizations and client memberships).
 *
 * Slice S4 (registry wave C). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Client-org management is confirm-class where it changes who a client is or who can see the
 * portal, because that exposure is client-visible (plan §2, "shares to clients").
 */
import { z } from 'zod';
import { CLIENT_ROLES } from '@tmanage/domain';
import { MEMBERSHIP_STATUS } from '../../../common/database/schema.js';
import { det, queryArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

/** = clients.controller.ts MAX_NAME_LENGTH (not exported). */
const CLIENT_ORG_NAME_MAX = 190;

/** = clients.controller.ts `listMemberships`: a comma-separated subset of the membership statuses. */
const membershipStatuses = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (raw) =>
      raw
        .split(',')
        .map((v) => v.trim())
        .every((v) => (MEMBERSHIP_STATUS as readonly string[]).includes(v)),
    `must be a comma-separated subset of ${MEMBERSHIP_STATUS.join(', ')}`,
  )
  .describe(`Comma-separated, any of ${MEMBERSHIP_STATUS.join(', ')}`);

export const clientsDetails: readonly AiActionDetail[] = [
  det({
    id: 'client_organizations.list',
    title: 'List client organizations',
    description:
      'The client companies this workspace works with. Archived ones only when includeArchived ' +
      'is true.',
    input: queryArgs([], { includeArchived: f.bool().optional() }),
    redact: 'standard',
    examples: [{ summary: 'All active', args: {} }],
  }),
  det({
    id: 'client_organizations.get',
    title: 'Get a client organization',
    description: 'One client company by id, with its portal and contact summary.',
    input: pathOnly('clientOrganizationId'),
    redact: 'standard',
    examples: [{ summary: 'By id', args: { clientOrganizationId: 'co_123' } }],
  }),
  det({
    id: 'client_organizations.create',
    title: 'Add a client organization',
    description: 'Create a client company record.',
    input: bodyArgs([], { name: f.shortText(CLIENT_ORG_NAME_MAX) }),
    redact: 'standard',
    examples: [{ summary: 'New client', args: { name: 'Northwind Ltd' } }],
  }),
  det({
    id: 'client_organizations.update',
    title: 'Update a client organization',
    description:
      'Rename a client company. updatedAt is the value from client_organizations.get or ' +
      'client_organizations.list (a stale one is refused).',
    input: bodyArgs(['clientOrganizationId'], {
      name: f.shortText(CLIENT_ORG_NAME_MAX),
      updatedAt: f.iso(),
    }),
    redact: 'standard',
    examples: [
      {
        summary: 'Rename',
        args: {
          clientOrganizationId: 'co_123',
          name: 'Northwind Inc',
          updatedAt: '2026-11-20T09:30:00.000Z',
        },
      },
    ],
  }),
  det({
    id: 'client_organizations.delete',
    title: 'Delete a client organization',
    description: 'Remove a client company. Confirm-class: it affects portal access.',
    input: pathOnly('clientOrganizationId'),
    redact: 'standard',
    examples: [{ summary: 'Delete', args: { clientOrganizationId: 'co_123' } }],
  }),
  det({
    id: 'client_memberships.list',
    title: 'List client members',
    description:
      'People who can sign in to a client portal, optionally for one client and by status. ' +
      'Expired ones only with includeExpired; names and e-mails with withPeople.',
    input: queryArgs([], {
      clientOrganizationId: f.id().optional(),
      status: membershipStatuses.optional(),
      includeExpired: f.bool().optional(),
      withPeople: f.bool().optional(),
    }),
    redact: 'client_safe',
    examples: [{ summary: 'For one client', args: { clientOrganizationId: 'co_123' } }],
  }),
  det({
    id: 'client_memberships.create',
    title: 'Grant client portal access',
    description: 'Give a person access to a client portal in a role. Confirm-class: client-facing.',
    input: bodyArgs([], {
      clientOrganizationId: f.id(),
      userId: f.id(),
      role: z.enum(CLIENT_ROLES),
      expiresAt: f
        .iso()
        .nullish()
        .describe('Leave out for the policy default; null for no end date'),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Add a viewer',
        args: { clientOrganizationId: 'co_123', userId: 'u_9', role: 'client_viewer' },
      },
    ],
  }),
  det({
    id: 'client_memberships.update',
    title: 'Update client portal access',
    description:
      "Change exactly one of a client member's role, expiry (null for none) or status per call. " +
      'updatedAt is the value from client_memberships.list. Confirm-class: client-facing.',
    // = clients.controller.ts `updateMembership`: updatedAt plus exactly one of the three.
    input: (
      bodyArgs(['clientMembershipId'], {
        updatedAt: f.iso(),
        role: z.enum(CLIENT_ROLES).optional(),
        status: z.enum(MEMBERSHIP_STATUS).optional(),
        expiresAt: f.iso().nullable().optional(),
      }) as z.ZodObject<z.ZodRawShape>
    ).refine(
      (v: Record<string, unknown>) =>
        ['role', 'expiresAt', 'status'].filter((k) => k in v).length === 1,
      { message: 'change exactly one of role, expiresAt or status per request', path: ['role'] },
    ),
    redact: 'client_safe',
    examples: [
      {
        summary: 'Suspend',
        args: {
          clientMembershipId: 'cm_1',
          updatedAt: '2026-11-20T09:30:00.000Z',
          status: 'suspended',
        },
      },
    ],
  }),
  det({
    id: 'client_organizations.invitations.list',
    title: 'List client company invitations',
    description:
      'Invitations issued into one client company; pending ones unless status says otherwise.',
    input: queryArgs(['clientOrganizationId'], { status: f.shortText(80).optional() }),
    redact: 'client_safe',
    examples: [{ summary: 'Pending', args: { clientOrganizationId: 'co_123' } }],
  }),
  det({
    id: 'client_organizations.projects.list',
    title: 'List projects shared with a client company',
    description: 'Id, name, status and share date of every active project shared with one client.',
    input: pathOnly('clientOrganizationId'),
    redact: 'client_safe',
    examples: [{ summary: 'One company', args: { clientOrganizationId: 'co_123' } }],
  }),
  det({
    id: 'client_organizations.options.list',
    title: 'List client companies to pick from',
    description: 'Id and name of every active client company, for choosing a project client.',
    input: queryArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
  // ONEPAGE (B01): the client page in one read, across the projects shared with the client.
  det({
    id: 'client_organizations.summary.get',
    title: 'Get a client at a glance',
    description:
      'One client company in one read: its projects and their health, approvals waiting, latest ' +
      'files, time, money (with finance access) and risks. A block you may not read is absent.',
    input: pathOnly('clientOrganizationId'),
    redact: 'billing',
    examples: [{ summary: 'How is Northwind doing?', args: { clientOrganizationId: 'co_123' } }],
  }),
];
