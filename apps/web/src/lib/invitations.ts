/**
 * The checks `ON-04` runs on an email address before it becomes an invitation.
 *
 * `22-SCREEN-BY-SCREEN` §3: "Email list, role, project access; preview each role; invalid
 * domains and duplicates inline."
 *
 * "Inline" is the part that decides where this code lives. The three problems below are all
 * knowable in the browser from what the screen already has — the organization's own domain,
 * the addresses already added, and the existing members — so telling the person about them
 * costs no round trip and no waiting. What is *not* knowable here is whether an address will
 * be accepted: only the server knows whether an invitation already exists for it, and this
 * module never pretends otherwise.
 *
 * ## Why the address check is deliberately loose
 *
 * `isPlausibleEmail` rejects the obviously broken and nothing else. The full grammar in
 * RFC 5322 admits quoted local parts, comments and address literals; a regular expression
 * that tried to enforce it would be famous for its length and would still reject valid
 * addresses at real companies. The authority on whether an address works is whether mail
 * arrives at it, which is the invitation itself.
 */

export type InviteProblem =
  /** Not an address we can send to at all. */
  | 'malformed'
  /** The same address appears twice in this list. */
  | 'duplicate-in-list'
  /** The address already belongs to a member of this organization. */
  | 'already-a-member'
  /** Outside the organization's own domain — a client, not a colleague. */
  | 'outside-domain';

export interface InviteCandidate {
  readonly email: string;
  readonly role: string;
}

export interface CheckedInvite extends InviteCandidate {
  readonly problems: readonly InviteProblem[];
  /** True when the address may be sent as written. */
  readonly sendable: boolean;
}

export interface CheckInvitesInput {
  readonly candidates: readonly InviteCandidate[];
  /** The organization's own mail domain, e.g. `northstar.studio`. Lowercase. */
  readonly organizationDomain: string;
  /** Addresses that already hold a membership. Compared case-insensitively. */
  readonly existingMembers: readonly string[];
}

/** Rejects the obviously broken. See the note above on why it does no more than that. */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/**
 * Check a whole list at once.
 *
 * The list is checked as a unit rather than address by address because two of the three
 * problems are properties of the list: a duplicate needs its twin, and "already a member"
 * needs the membership list. Returning one result per input row, in input order, keeps the
 * screen's rendering a straight map with no lookup.
 *
 * A duplicate marks the *later* occurrence, not both. Marking both would tell someone who
 * typed an address once and pasted it again that their original entry is wrong.
 */
export function checkInvites({
  candidates,
  organizationDomain,
  existingMembers,
}: CheckInvitesInput): readonly CheckedInvite[] {
  const members = new Set(existingMembers.map((email) => email.trim().toLowerCase()));
  const seen = new Set<string>();

  return candidates.map((candidate) => {
    const email = candidate.email.trim();
    const normalised = email.toLowerCase();
    const problems: InviteProblem[] = [];

    if (!isPlausibleEmail(email)) {
      problems.push('malformed');
    } else {
      if (seen.has(normalised)) problems.push('duplicate-in-list');
      if (members.has(normalised)) problems.push('already-a-member');
      if (organizationDomain !== '' && domainOf(email) !== organizationDomain) {
        problems.push('outside-domain');
      }
      seen.add(normalised);
    }

    return { ...candidate, email, problems, sendable: problems.length === 0 };
  });
}

/**
 * One sentence per problem, addressed to the person adding the invitation.
 *
 * `outside-domain` is phrased as a redirection rather than a refusal, because it is not an
 * error: a client's address is a perfectly good address, it just does not make them a
 * colleague. `12-PERMISSION-MATRIX` keeps the two audiences apart, and inviting a client as
 * an internal member is the mistake that would quietly hand them internal costs and comments.
 */
export function describeInviteProblem(problem: InviteProblem, organizationDomain: string): string {
  switch (problem) {
    case 'malformed':
      return 'That does not look like an email address.';
    case 'duplicate-in-list':
      return 'This address is already in the list below.';
    case 'already-a-member':
      return 'This person is already a member. No second invitation will be sent.';
    case 'outside-domain':
      return `This address is outside ${organizationDomain}. Client people are invited as a client organization, not as internal members.`;
  }
}
