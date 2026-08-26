import { INTERNAL_ROLES } from '@tmanage/domain';
import type { InternalRole } from '@tmanage/domain';

/**
 * What each internal role can actually do, in sentences.
 *
 * `22-SCREEN-BY-SCREEN` §3 asks `ON-04` to "preview each role", and the preview is the half
 * that matters: a role name is a label, and the person sending an invitation is responsible for
 * what it grants. The sentences are drawn from `12-PERMISSION-MATRIX` §1 and §2.
 *
 * ## The roles here are the roles the system has
 *
 * `ON-04` shipped with `admin`, `member` and `viewer`, and **two of those are not roles**.
 * `INTERNAL_ROLES` is `owner`, `org_admin`, `workspace_admin`, `manager`, `moderator`,
 * `member`, `guest`. Nothing caught it because nothing was sent — invitations did not exist —
 * and the first request TEN-003 would have refused is the one that made it visible.
 *
 * The list is keyed by the domain's own type, so a role added to `packages/domain` and not
 * described here is a **type error** rather than a screen that silently omits it.
 */

export interface RoleDescription {
  readonly label: string;
  /** Plain sentences. Each is a thing the person *will* be able to do. */
  readonly grants: readonly string[];
  /** One sentence naming what they will not. Rendered with equal weight, never as fine print. */
  readonly withholds: string;
}

const DESCRIPTIONS: Record<InternalRole, RoleDescription> = {
  owner: {
    label: 'Owner',
    grants: [
      'Everything an organization admin can do',
      'Change security settings and billing',
      'Delete the organization',
    ],
    withholds: 'There is nothing an owner cannot do. Grant it deliberately.',
  },
  org_admin: {
    label: 'Organization admin',
    grants: [
      'Everything a team member can do, in every project',
      'Invite people and change their roles',
      'Set up client organizations and share projects with them',
    ],
    withholds: 'Cannot delete the organization or change billing.',
  },
  workspace_admin: {
    label: 'Workspace admin',
    grants: [
      'Everything a team member can do, in their workspace',
      'Create and archive projects in that workspace',
    ],
    withholds: 'Cannot invite people to the organization or change anybody’s role.',
  },
  manager: {
    label: 'Manager',
    grants: [
      'Every project they are assigned to',
      'Publish work and deliverables to clients',
      'Triage client requests and commit to dates',
    ],
    withholds: 'Cannot invite people to the organization or change anybody’s role.',
  },
  moderator: {
    label: 'Moderator',
    grants: [
      'Every project they are assigned to',
      'Moderate conversations: edit and remove messages',
    ],
    withholds: 'Cannot publish to clients or change anybody’s role.',
  },
  member: {
    label: 'Team member',
    grants: [
      'Every internal project they are assigned to',
      'Chat channels they join, plus project channels',
      'Work, docs and files in their projects',
    ],
    withholds: 'Cannot change roles, publish to clients, or open the Control Center.',
  },
  guest: {
    label: 'Guest',
    grants: ['Read-only access to the projects they are assigned to'],
    withholds: 'Cannot change anything at all.',
  },
};

/** The roles `ON-04` offers, in the order it offers them: the common case first. */
export const INVITABLE_ROLES: readonly InternalRole[] = ['member', 'org_admin', 'guest'];

export function describeInternalRole(role: string): RoleDescription {
  if (isInternalRoleName(role)) return DESCRIPTIONS[role];
  // A role the API knows and this file does not. The label is the raw value rather than a
  // guess, because inventing a description for an unknown grant is the one failure mode this
  // whole file exists to prevent.
  return {
    label: role,
    grants: ['This role is not described here yet.'],
    withholds: 'Check the permission matrix before sending this invitation.',
  };
}

function isInternalRoleName(value: string): value is InternalRole {
  return (INTERNAL_ROLES as readonly string[]).includes(value);
}
