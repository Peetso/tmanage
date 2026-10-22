/**
 * BK3 (COL-03) — who may hold a one-to-one direct conversation with whom, as one pure rule shared
 * by the API (every DM read and post) and the worker (the socket subscription and the recipient's
 * notice), so the two paths cannot disagree:
 *
 * - two internal members: always;
 * - a client person and an internal member: only if they share a project;
 * - two client people: only within the same client organization.
 */

/** A participant as the relation rule sees them. Null when the user is not an active member. */
export interface DirectParty {
  readonly userId: string;
  readonly kind: 'internal' | 'client';
  /** For a client person, the client organizations they belong to here. Empty for internal. */
  readonly clientOrganizationIds: readonly string[];
  /** Internal: projects they are a member of. Client: projects shared with their client org(s). */
  readonly projectIds: readonly string[];
}

export function mayDirectMessage(a: DirectParty | null, b: DirectParty | null): boolean {
  if (a === null || b === null || a.userId === b.userId) return false;
  if (a.kind === 'internal' && b.kind === 'internal') return true;
  if (a.kind === 'client' && b.kind === 'client') {
    return a.clientOrganizationIds.some((id) => b.clientOrganizationIds.includes(id));
  }
  return a.projectIds.some((id) => b.projectIds.includes(id));
}
