import { isPlatformSupportRole } from './capabilities.js';

/**
 * QA-FIX-P S3 — who may act on whom among an organization's own members.
 *
 * One decision, one place (AR-8): every member-management action that can lock a person out or
 * change what they may do — send a password reset, end their sessions, change their role,
 * remove them — asks this module before it writes. The rule is the one Google Workspace states
 * for password resets ("To reset the password of another administrator, you must have Super
 * Admin privileges", knowledge.workspace.google.com/admin/users/reset-a-users-password) and that
 * OWASP ASVS 5.0 V8.2.2 asks of every data-specific action: the actor needs authority over the
 * specific person, not only the capability in general.
 *
 *   - **owner** (and the hidden Support-session role, which carries the owner's ceiling) may act
 *     on anyone else, another owner included — ownership is shared, not ranked.
 *   - **admin** — any role whose capabilities include `org.manage`, built-in or custom — may act
 *     only on someone with less authority: never on an owner, never on another admin.
 *   - **member** — everyone else — has no member-management authority over anyone.
 *
 * Acting on yourself is not this module's question; each route has its own self rule.
 * Pure: no I/O, no clock, so the API and the web read the same answer.
 */
export type MemberAuthorityTier = 'owner' | 'admin' | 'member';

const TIER_RANK: Readonly<Record<MemberAuthorityTier, number>> = {
  owner: 3,
  admin: 2,
  member: 1,
};

function asSet(capabilities: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return capabilities instanceof Set ? capabilities : new Set(capabilities);
}

/**
 * The authority tier of a role. `capabilities` is what the role (or the actor's resolved
 * context, overrides included) actually holds — a custom role id alone says nothing.
 */
export function memberAuthorityTier(
  role: string,
  capabilities: ReadonlySet<string> | readonly string[],
): MemberAuthorityTier {
  if (role === 'owner' || isPlatformSupportRole(role)) return 'owner';
  return asSet(capabilities).has('org.manage') ? 'admin' : 'member';
}

/**
 * May an actor of tier `actor` reset, sign out, remove or re-role a person of tier `target`?
 * An owner may act on anyone; anyone else only on a strictly lower tier.
 */
export function mayActOnMember(actor: MemberAuthorityTier, target: MemberAuthorityTier): boolean {
  if (actor === 'owner') return true;
  return TIER_RANK[actor] > TIER_RANK[target];
}

/**
 * QA-FIX-P S2 (ADR-0014) — how much of the organization's roster a viewer is shown.
 *
 *   - `organization`: every active member, as in Slack's member directory.
 *   - `shared_projects`: a guest sees only people who share a project with them (and
 *     themselves), as Asana shows guests only what is shared with them.
 */
export type RosterScope = 'organization' | 'shared_projects';

export function rosterScopeFor(role: string): RosterScope {
  return role === 'guest' ? 'shared_projects' : 'organization';
}

/**
 * Whether the viewer gets the administration fields of a roster row (status, e-mail). Only
 * someone who manages members — `org.manage` — needs them (ASVS 5.0 V8.2.3,
 * field-level access).
 */
export function seesRosterAdminFields(
  capabilities: ReadonlySet<string> | readonly string[],
): boolean {
  return asSet(capabilities).has('org.manage');
}
