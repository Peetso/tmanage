import { CAPABILITIES, capabilitySetFor, customRoleIdOf, type Capability } from './capabilities.js';
import {
  authorize,
  type AuthorizationDecision,
  type OrganizationPolicy,
  type Principal,
  type ResourceContext,
} from './authorize.js';

/**
 * platform-admin v2 · PA-01 — "what can this person do" (SPEC §3.3, D8, B4 drawer).
 *
 * Not a second evaluator. Every answer here is the real `authorize()` run against a synthetic
 * resource: an org-level resource (no project) for the org-wide answer, a project the person is
 * not on for the reach answer, and — when the screen simulates one — the chosen project. The
 * `source` only explains *why* the evaluator said what it said, so the screen can colour the
 * cell: granted by the role, by a custom role, by an allow override; refused by a deny override,
 * by org policy, or simply not in the role.
 */

export type EffectivePermissionSource =
  'role' | 'custom_role' | 'override_allow' | 'override_deny' | 'org_policy_off' | 'not_in_ceiling';

/** Where an allowed capability reaches: the whole org, the person's projects, or their own. */
export type EffectivePermissionScope = 'org' | 'projects' | 'own';

export interface EffectivePermissionEntry {
  readonly capability: Capability;
  readonly final: boolean;
  readonly source: EffectivePermissionSource;
  readonly scope: EffectivePermissionScope;
}

export type EffectivePermissionsView = readonly EffectivePermissionEntry[];

/** The project the screen simulates on. `member` = the person is on that project. */
export interface SimulatedProject {
  readonly id: string;
}

export interface ComputeEffectivePermissionsInput {
  readonly principal: Principal;
  readonly orgPolicy?: OrganizationPolicy;
  readonly project?: SimulatedProject | null;
}

/**
 * A project id no principal is ever a member of, used to ask "does the reach come from the
 * organization or from project relations?" without naming a real project. The nil UUID is never
 * issued by `uuidv7()`.
 */
const NOT_A_PROJECT = '00000000-0000-0000-0000-000000000000';

/**
 * Capabilities whose reach is the person's own records (`12-PERMISSION-MATRIX` §2 "View audit
 * log: Own activity" for member and guest). Only a scope label — `authorize()` is still what
 * decides, and the audit service applies the narrowing.
 */
const OWN_SCOPE_ROLES: ReadonlySet<string> = new Set(['member', 'guest']);

function resourceFor(principal: Principal, projectId: string | null): ResourceContext {
  return {
    organizationId: principal.organizationId,
    projectId,
    audience: principal.kind === 'client' ? 'client_visible' : 'internal',
    clientOrganizationId: principal.clientOrganizationId,
    lifecycle: 'active',
    isPublished: true,
    // A role does not carry the reviewer relation; the preview asks about the permission, and
    // each approval still checks the assignment when it is decided.
    isAssignedReviewer: true,
  };
}

function sourceOf(
  principal: Principal,
  capability: Capability,
  decision: AuthorizationDecision,
): EffectivePermissionSource {
  const custom = customRoleIdOf(principal.role) !== null;
  if (decision.allowed) {
    const inRole = capabilitySetFor(principal.role).has(capability);
    if (!inRole) return 'override_allow';
    return custom ? 'custom_role' : 'role';
  }
  switch (decision.code) {
    case 'capability_denied_by_override':
      return 'override_deny';
    case 'capability_disabled_by_policy':
      return 'org_policy_off';
    default:
      return 'not_in_ceiling';
  }
}

/**
 * The effective permission of every capability for `principal`, in `CAPABILITIES` order.
 *
 * `final` is the org-level answer, or — with `project` — the answer on that project.
 */
export function computeEffectivePermissions(
  input: ComputeEffectivePermissionsInput,
): EffectivePermissionsView {
  const { principal, orgPolicy, project } = input;
  const ask = (capability: Capability, projectId: string | null) =>
    authorize({
      principal,
      capability,
      resource: resourceFor(principal, projectId),
      ...(orgPolicy ? { policy: orgPolicy } : {}),
    });

  return CAPABILITIES.map((capability) => {
    const orgLevel = ask(capability, null);
    const onProject = project ? ask(capability, project.id) : orgLevel;
    const decision = project ? onProject : orgLevel;
    const reachesAnyProject = ask(capability, NOT_A_PROJECT).allowed;
    const scope: EffectivePermissionScope =
      capability === 'audit.read' && OWN_SCOPE_ROLES.has(principal.role)
        ? 'own'
        : reachesAnyProject
          ? 'org'
          : 'projects';
    return Object.freeze({
      capability,
      final: decision.allowed,
      source: sourceOf(principal, capability, decision.allowed ? decision : orgLevel),
      scope,
    });
  });
}
