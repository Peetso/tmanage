import { capabilitiesFor, isCustomRoleKey, isInternalRole } from '../capabilities.js';
import type { Capability, PrincipalRole } from '../capabilities.js';

/**
 * 60-01 (plan 60 v2 §4.6 step 5, §4.7, §5 "least privilege"). The AI ceiling: what an `ai`
 * membership may hold at most, whatever its role, custom role or overrides say.
 *
 * Every capability is classified here, in a `Record` keyed by `Capability`, so a capability added
 * to `CAPABILITIES` without a decision for AI employees is a type error, not a silent grant (the
 * plan's "a new route cannot become reachable by accident", made mechanical; AR-8, AR-12):
 *
 * - `allowed`: an AI employee may hold it, still only inside its role, its overrides and its
 *   sponsor's current rights ({@link aiEffectiveCapabilities}). These are the reads of the task's
 *   project and the writes the agent contract needs (comment, upload, a deliverable version).
 * - `masked`: never held by an AI employee. A role that carries it is still acceptable; the
 *   capability is simply removed (creating work, moving states, reviewing, searching the
 *   workspace, using TManage's own AI, reports).
 * - `admin`: never held, and a role that carries it is **refused** for an AI employee (400 at
 *   the role-grant door, the details name them; {@link aiRoleDecision}): administration, people,
 *   billing, finance, settings, integrations and tokens, export, delete, approval decisions,
 *   publishing, client membership and the AI-employee and brief rights themselves.
 *
 * Pure: no I/O, no clock.
 */
export type AiCapabilityClass = 'allowed' | 'masked' | 'admin';

export const AI_CAPABILITY_CLASS: Readonly<Record<Capability, AiCapabilityClass>> = Object.freeze({
  'org.manage': 'admin',
  'org.security.manage': 'admin',
  'workspace.manage': 'admin',
  'project.create': 'admin',
  'project.manage': 'admin',
  'project.member.manage': 'admin',
  'conversation.read': 'allowed',
  // A comment on its own task; mention limits are the contract's (60-28).
  'conversation.write': 'allowed',
  'conversation.moderate': 'admin',
  'work.read': 'allowed',
  // Briefed tasks only (open question 8): no task creation, no field edits, no state moves. The
  // assignment state is the agent contract's; the two task-state mappings are the server's.
  'work.create': 'masked',
  'work.update': 'masked',
  'work.transition': 'masked',
  'meeting.read': 'allowed',
  'meeting.write': 'masked',
  'doc.read': 'allowed',
  'doc.write': 'masked',
  'client_projection.read': 'masked',
  'client_request.submit': 'masked',
  'client_request.triage': 'masked',
  // A submission becomes a deliverable version for review (60-24/60-26).
  'deliverable.create': 'allowed',
  'deliverable.review': 'masked',
  'deliverable.publish': 'admin',
  'approval.read': 'allowed',
  // §4.7: an AI employee never decides an approval step.
  'approval.decide': 'admin',
  'client_member.manage': 'admin',
  'audit.read': 'masked',
  'audit.export': 'admin',
  'member.offboard': 'admin',
  'file.upload': 'allowed',
  'file.download': 'allowed',
  'search.use': 'masked',
  'project.delete': 'admin',
  'work.delete': 'admin',
  'work.export': 'admin',
  'conversation.delete': 'admin',
  'conversation.export': 'admin',
  'doc.delete': 'admin',
  'doc.export': 'admin',
  'decision.read': 'allowed',
  'decision.write': 'masked',
  'decision.delete': 'admin',
  'meeting.delete': 'admin',
  'file.delete': 'admin',
  'storage.manage': 'admin',
  // The directory: AI comments may not mention people outside the project (§5).
  'people.view': 'masked',
  'people.invite': 'admin',
  'people.edit': 'admin',
  'roles.assign': 'admin',
  'billing.view': 'admin',
  'billing.manage': 'admin',
  'settings.view': 'admin',
  // TManage's own AI and its connector tokens are for people (plan 62); an AI employee works only
  // through the agent contract.
  'ai.use': 'masked',
  'ai.manage': 'admin',
  'report.view': 'masked',
  'report.export': 'admin',
  'finance.view': 'admin',
  'finance.manage': 'admin',
  'time.view_team': 'admin',
  // AI-to-AI delegation is refused (§9); an AI never hires, assigns or edits the brief library.
  'ai_employee.manage': 'admin',
  'ai_employee.assign': 'admin',
  'brief.manage': 'admin',
});

/** The capabilities an AI employee may hold at most, in `CAPABILITIES` order. */
export const AI_ALLOWED_CAPABILITIES: readonly Capability[] = Object.freeze(
  (Object.keys(AI_CAPABILITY_CLASS) as Capability[]).filter(
    (capability) => AI_CAPABILITY_CLASS[capability] === 'allowed',
  ),
);

/** The built-in roles an AI employee may be given. Every other built-in role is refused. */
export const AI_ASSIGNABLE_ROLES = ['member', 'guest'] as const;

export type AiAssignableRole = (typeof AI_ASSIGNABLE_ROLES)[number];

/** May an AI employee hold this capability at all? */
export function isAllowedForAi(capability: Capability): boolean {
  return AI_CAPABILITY_CLASS[capability] === 'allowed';
}

/** The answer of the role-grant door for an `ai` membership (AR-9: a decision, not a fact). */
export type AiRoleDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /**
       * `admin_role`: a built-in role other than member or guest (owner, org_admin,
       * workspace_admin, manager, moderator, platform_support). `admin_capabilities`: a custom role
       * that carries an `admin`-class capability. `not_internal`: a client role or a value that is
       * no role at all (an AI employee is always an internal principal).
       */
      readonly reason: 'admin_role' | 'admin_capabilities' | 'not_internal';
      /** For `admin_capabilities`: which ones, in input order, without duplicates. */
      readonly capabilities: readonly Capability[];
    };

/**
 * May an AI employee be given this role (plan 60 v2 §4.1 "role change to any admin role" and
 * §5 test 5 "a custom role with an admin capability is refused for kind ai")?
 *
 * A built-in role is decided by its name alone (member and guest only). A custom role is decided by
 * `capabilities`, which defaults to the set encoded in its key; the role-grant guard may pass the
 * custom role's freshly loaded list instead. A per-member allow list is checked with
 * {@link aiAdminCapabilitiesIn}.
 */
export function aiRoleDecision(
  role: PrincipalRole,
  capabilities: Iterable<Capability> = capabilitiesFor(role),
): AiRoleDecision {
  if (isInternalRole(role)) {
    return (AI_ASSIGNABLE_ROLES as readonly string[]).includes(role)
      ? { allowed: true }
      : { allowed: false, reason: 'admin_role', capabilities: [] };
  }
  if (!isCustomRoleKey(role)) return { allowed: false, reason: 'not_internal', capabilities: [] };
  const admin = aiAdminCapabilitiesIn(capabilities);
  return admin.length === 0
    ? { allowed: true }
    : { allowed: false, reason: 'admin_capabilities', capabilities: admin };
}

/**
 * The `admin`-class capabilities in a list, in input order and without duplicates. Empty means the
 * list may be given to an AI employee: the role-grant door asks it for a custom role's set, the
 * member-override door for an allow list.
 */
export function aiAdminCapabilitiesIn(capabilities: Iterable<Capability>): readonly Capability[] {
  const admin: Capability[] = [];
  for (const capability of capabilities) {
    if (AI_CAPABILITY_CLASS[capability] === 'admin' && !admin.includes(capability)) {
      admin.push(capability);
    }
  }
  return admin;
}

/**
 * What an AI employee holds on this request (plan 60 v2 §4.6 step 5): its own effective set
 * (role ∪ allow − deny), cut to the AI ceiling, and never above its sponsor's current effective
 * set. Re-computed on every call, so demoting the sponsor narrows the AI employee at once, and a
 * sponsor who holds nothing (left, suspended) leaves it nothing.
 *
 * Both inputs are the sets `effectiveCapabilitySet()` returns for each principal; the caller
 * loads the sponsor's membership in the same tenant read.
 */
export function aiEffectiveCapabilities(
  aiCapabilities: ReadonlySet<Capability>,
  sponsorCapabilities: ReadonlySet<Capability>,
): ReadonlySet<Capability> {
  const out = new Set<Capability>();
  for (const capability of aiCapabilities) {
    if (isAllowedForAi(capability) && sponsorCapabilities.has(capability)) out.add(capability);
  }
  return out;
}
