import type { ReactNode } from 'react';
import { InlineAlert } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { BackendPending } from './BackendPending';

export interface PlannedInternalScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The rail id of this destination, e.g. `home`. Marks the rail item current. */
  activeNavigationId: string;
  /** The one `<h1>` of the document — the destination's own name. */
  title: string;
  /** The supporting line beneath the title. */
  description: ReactNode;
  /**
   * The ticket that will build this destination, when one is scheduled.
   *
   * Present it only when a real ticket in `28-SPRINT-TICKETS-AND-ESTIMATES.md` owns the work —
   * `ticket-ids.test.ts` fails the suite for any id the plan does not schedule, which is the
   * guard against the invented ids the record lists. When no ticket schedules the destination,
   * omit it and the notice says so plainly rather than pointing a reader at a backlog row that
   * does not exist.
   */
  ticket?: string;
  /** What is not built, stated in the reader's terms. */
  children: ReactNode;
}

/**
 * An internal rail destination that is named but not yet built.
 *
 * `22-SCREEN-BY-SCREEN` §1 fixes the internal rail at eight destinations, and
 * `navigation.ts` exports all eight. Five have screens; `home`, `calendar`, `docs`, `people`
 * and `insights` did not, so the rail — and the brand link, which `AppShell` points at
 * `/{slug}/home` — led to routes Next answered with a 404. A destination the product draws in
 * its own navigation and then cannot open is worse than one it never claimed.
 *
 * This is the honest middle state the design already uses for a screen whose server does not
 * exist (`BackendPending`): the destination resolves, carries the full shell so the rail stays
 * reachable and the destination stays named and marked current, and says in plain words what
 * is not built. It never fabricates data to fill the canvas.
 *
 * A destination with a scheduled ticket names it; one without says there is no ticket yet,
 * because inventing a plausible id is exactly the drift `ticket-ids.test.ts` exists to catch.
 */
export function PlannedInternalScreen({
  organizationSlug,
  organizationName,
  activeNavigationId,
  title,
  description,
  ticket,
  children,
}: PlannedInternalScreenProps) {
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId={activeNavigationId}
      title={title}
      description={description}
    >
      {ticket !== undefined ? (
        <BackendPending ticket={ticket}>{children}</BackendPending>
      ) : (
        <InlineAlert tone="warning" title="Not built yet">
          {children}
        </InlineAlert>
      )}
    </AppShell>
  );
}
