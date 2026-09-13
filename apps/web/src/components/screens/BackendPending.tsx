import { InlineAlert } from '@tmanage/ui';
import type { ReactNode } from 'react';

/**
 * The heading a person using the product reads. Plain words, no identifier, no team voice.
 *
 * Exported so that a test asserts the string the screen renders rather than a copy of it.
 */
export const BACKEND_PENDING_TITLE = 'Not available yet';

export interface BackendPendingProps {
  /**
   * The ticket that will make this work, e.g. `ID-002`. Named, never vague — and shown to the
   * team only. `showTicket` decides whether it is rendered.
   */
  ticket: string;
  /**
   * Whether to append the ticket to the heading. Defaults to "not a production build".
   *
   * Passed explicitly by tests so that neither the development nor the production rendering
   * depends on what `NODE_ENV` happens to be when the suite runs.
   */
  showTicket?: boolean;
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
 * screen. The result is a screen a person can read, critique and navigate, that never claims
 * to have done something it did not do.
 *
 * `tone="warning"` rather than `danger`: nothing has gone wrong, something is not finished.
 *
 * ## Two readers, one notice
 *
 * The notice has two audiences and they need different things, which is why the ticket is no
 * longer part of the sentence a customer reads.
 *
 * - **The team**, in development, needs to know which ticket closes the gap. `ID-002` is a
 *   row in `28-SPRINT-TICKETS-AND-ESTIMATES.md` and following it is the point.
 * - **The person using the product**, in a production build, cannot look that row up, cannot
 *   act on it, and is not the audience for it. The 2026-09-05 review's §7 asks for internal
 *   identifiers to be kept out of customer-facing copy; until this ticket the heading put one
 *   in front of every reader on sixteen screens.
 *
 * So the identifier is gated on the build and the body says what is true, what it means for
 * the reader, and — where there is one — what they can do instead. The gate is
 * `process.env.NODE_ENV !== 'production'`, the same distinction `SignInScreen`'s
 * `developmentSignInEnabled` already draws for its development-only panel, rather than a
 * second mechanism invented for one component. Next inlines that comparison at build time, so
 * a production bundle does not merely hide the ticket at runtime — the branch is dead code and
 * the string is the only thing left.
 */
export function BackendPending({
  ticket,
  showTicket = process.env.NODE_ENV !== 'production',
  children,
}: BackendPendingProps) {
  return (
    <InlineAlert
      tone="warning"
      title={showTicket ? `${BACKEND_PENDING_TITLE} — ${ticket}` : BACKEND_PENDING_TITLE}
    >
      {children}
    </InlineAlert>
  );
}
