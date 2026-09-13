import type { ReactNode } from 'react';
import { InlineAlert } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { BackendPending } from './BackendPending';

export interface PlannedPortalScreenProps {
  organizationSlug: string;
  /** The client organization whose portal this is. Their name leads. */
  clientName: string;
  /** The delivery team's name, shown beneath the client's. */
  providerName: string;
  /** The portal nav id of this destination, e.g. `deliverables`. */
  activeNavigationId: string;
  /** The one `<h1>` of the document — the destination's own name. */
  title: string;
  /** The supporting line beneath the title. */
  description: ReactNode;
  /**
   * The ticket that will build this destination, when one is scheduled — see
   * `PlannedInternalScreen` for why an absent ticket is stated rather than invented.
   */
  ticket?: string;
  /** What is not built, in the client's terms. */
  children: ReactNode;
}

/**
 * A client-portal destination that is named but not yet built.
 *
 * `22-SCREEN-BY-SCREEN` §1 fixes the portal nav at seven destinations and `navigation.ts`
 * exports all seven; `overview` and `actions` have screens, and `deliverables`, `timeline`,
 * `updates`, `files` and `people` did not, so five of a client's own tabs answered with a 404.
 * A client following a tab they were shown into nothing is the portal telling them, wrongly,
 * that something is broken.
 *
 * The portal is a separate space, not a reduced internal one (`ClientPortalShell` states the
 * tenancy reason), so its unbuilt destinations get the portal shell — the client's name
 * leading, the portal nav present and this tab marked current — and the same honest notice the
 * rest of the portal uses where a projection does not exist yet. Nothing here invents a
 * deliverable, a date or a file.
 */
export function PlannedPortalScreen({
  organizationSlug,
  clientName,
  providerName,
  activeNavigationId,
  title,
  description,
  ticket,
  children,
}: PlannedPortalScreenProps) {
  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
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
    </ClientPortalShell>
  );
}
