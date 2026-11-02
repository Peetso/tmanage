import { capabilitiesFor } from './capabilities.js';
import type { Capability, PrincipalRole } from './capabilities.js';

/**
 * 56-28 (deliverable 3) — the client-ceiling review, as code.
 *
 * `57` asked for it (BILL-01): a client principal must never become a hidden internal seat. The
 * plan's list of what a client role may hold is mapped here onto the capability keys that exist
 * today. Anything outside this list on a client role — a built-in ceiling edited by mistake, or a
 * custom role granted to a client membership — is a violation: the role-grant guard refuses it
 * (422 `client_ceiling`) and the policy simulator warns about it.
 *
 * Pure: no I/O, no clock.
 */
export const CLIENT_CAPABILITY_ALLOWLIST: readonly Capability[] = Object.freeze([
  // 12 §2 "View client projection" — the one read every client role has.
  'client_projection.read',
  'client_request.submit',
  // "approval.read/decide (assigned)": the assignment is a relation check in `authorize()`.
  'approval.read',
  'approval.decide',
  // "file.upload/download (client audience)": the audience is checked per file.
  'file.upload',
  'file.download',
  // Not in the 56-28 sentence, but in today's ceilings AND in 12 §2 ("Invite client users:
  // within own client org" and "View audit log: client-side subset"), so allowlisted on purpose.
  'client_member.manage',
  'audit.read',
  // Omitted on purpose: `conversation.read/write` and `search.use` exist, but they are
  // internal-only keys here. A client reads/posts in a group chat through the member-relation
  // exception (`CLIENT_GROUP_CHAT_CAPABILITIES`), never through a ceiling grant, and no
  // portal-scoped search key exists yet. The 52-13 portal finance reads have no key yet either.
]);

const ALLOWED: ReadonlySet<Capability> = new Set(CLIENT_CAPABILITY_ALLOWLIST);

/** Is this capability outside what any client principal may hold? */
export function isInternalCapabilityForClient(capability: Capability): boolean {
  return !ALLOWED.has(capability);
}

/**
 * The capabilities in `capabilities` (default: the role's own set) that a client role may not
 * hold, in input order and without duplicates. Empty means the role is within the client ceiling.
 */
export function clientCeilingViolations(
  role: PrincipalRole,
  capabilities: Iterable<Capability> = capabilitiesFor(role),
): readonly Capability[] {
  const out: Capability[] = [];
  for (const capability of capabilities) {
    if (isInternalCapabilityForClient(capability) && !out.includes(capability)) {
      out.push(capability);
    }
  }
  return out;
}
