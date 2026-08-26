import { InlineAlert } from '@tmanage/ui';
import type { ReactNode } from 'react';

export interface BackendPendingProps {
  /** The ticket that will make this work, e.g. `ID-002`. Named, never vague. */
  ticket: string;
  children: ReactNode;
}

/**
 * The notice a screen carries where its server side does not exist yet.
 *
 * WEB-001 builds nine screens against an API that can currently do one thing for an
 * unauthenticated person: issue a session for a user id supplied on trust. Passwords,
 * passkeys, MFA, invitations, organization creation and team invitations are all later
 * tickets.
 *
 * A screen could hide that by simulating the missing half — a fake delay, a canned success,
 * a hard-coded organization list. This component exists so that none of them do. Every
 * control whose backing endpoint is unwritten is `disabled`, and the reason is stated on the
 * screen with the ticket number that closes it. The result is a screen a person can read,
 * critique and navigate, that never claims to have done something it did not do.
 *
 * `tone="warning"` rather than `danger`: nothing has gone wrong, something is not finished.
 */
export function BackendPending({ ticket, children }: BackendPendingProps) {
  return (
    <InlineAlert tone="warning" title={`Not built yet — ${ticket}`}>
      {children}
    </InlineAlert>
  );
}
