/**
 * AI action details — clients (client organizations and client memberships).
 *
 * Slice S4 (registry wave C). Enrichment for the ops classified in `index.ts`; see `detail.ts`.
 * Client-org management is confirm-class where it changes who a client is or who can see the
 * portal, because that exposure is client-visible (plan §2, "shares to clients").
 */
import { det, listArgs, pathOnly, bodyArgs, f, type AiActionDetail } from './detail.js';

export const clientsDetails: readonly AiActionDetail[] = [
  det({
    id: 'client_organizations.list',
    title: 'List client organizations',
    description: 'The client companies this workspace works with.',
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'First page', args: { limit: 20 } }],
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
    input: bodyArgs([], { name: f.shortText(200) }),
    redact: 'standard',
    examples: [{ summary: 'New client', args: { name: 'Northwind Ltd' } }],
  }),
  det({
    id: 'client_organizations.update',
    title: 'Update a client organization',
    description: 'Rename a client company (optimistic concurrency via updatedAt).',
    input: bodyArgs(['clientOrganizationId'], {
      name: f.shortText(200).optional(),
      updatedAt: f.iso().optional(),
    }),
    redact: 'standard',
    examples: [
      { summary: 'Rename', args: { clientOrganizationId: 'co_123', name: 'Northwind Inc' } },
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
    description: 'People who can sign in to a client portal. Confirm-class: client-facing access.',
    input: listArgs([], { clientOrganizationId: f.id().optional() }),
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
      role: f.shortText(40),
      expiresAt: f.iso().nullish(),
    }),
    redact: 'client_safe',
    notifies: true,
    examples: [
      {
        summary: 'Add a viewer',
        args: { clientOrganizationId: 'co_123', userId: 'u_9', role: 'viewer' },
      },
    ],
  }),
  det({
    id: 'client_memberships.update',
    title: 'Update client portal access',
    description: "Change a client member's role, expiry or status. Confirm-class: client-facing.",
    input: bodyArgs(['clientMembershipId'], {
      role: f.shortText(40).optional(),
      status: f.shortText(40).optional(),
      expiresAt: f.iso().nullish(),
      updatedAt: f.iso().optional(),
    }),
    redact: 'client_safe',
    examples: [{ summary: 'Suspend', args: { clientMembershipId: 'cm_1', status: 'suspended' } }],
  }),
  det({
    id: 'client_organizations.invitations.list',
    title: 'List client company invitations',
    description:
      'Invitations issued into one client company; pending ones unless status says otherwise.',
    input: listArgs(['clientOrganizationId'], { status: f.shortText(80).optional() }),
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
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'All', args: {} }],
  }),
];
