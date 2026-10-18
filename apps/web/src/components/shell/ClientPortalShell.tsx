import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, LiveAnnouncer, SkipLink, StatusDot } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { CLIENT_NAVIGATION } from './navigation';
import { usePortalNames } from '../../lib/use-organization-names';

export interface ClientPortalShellProps {
  /**
   * The organization whose portal this is, as it appears in a URL.
   *
   * Every portal destination lives under it — `CLIENT_NAVIGATION` carries the suffix and this
   * supplies the prefix — because the portal is tenant-scoped exactly as every other screen
   * is: the slug in the path is the claim the API's `TenantContextGuard` resolves against a
   * membership row before any handler runs.
   */
  organizationSlug: string;
  /** The client organization whose portal this is. Their name leads, not the vendor's. */
  clientName: string;
  /** The delivery team's name, shown as the smaller "delivered by" line. */
  providerName: string;
  /** The project, when the portal is scoped to one. `22` §1: "project selector if authorized". */
  projectName?: string;
  activeNavigationId?: string;
  title: string;
  /** The mono eyebrow over the title, e.g. "Your project · on track for the committed launch". */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** The header's trailing block — CL-01's "days to launch" / "action waiting for you" metrics. */
  headerAside?: ReactNode;
  children: ReactNode;
  /**
   * Renders the internal-facing preview chrome around the portal — the `ClientPreviewBar`
   * of the design inventory. Off by default, because the client's own view must never carry
   * it.
   */
  preview?: boolean;
}

/**
 * The client portal shell — the second of the two shells `22-SCREEN-BY-SCREEN` §1 defines.
 *
 * It is a separate component rather than `AppShell` with a flag, and that is a tenancy
 * decision rather than a styling one. `12-PERMISSION-MATRIX` and the audience rules in
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` mean a client sees a different space, not a
 * reduced one. If the portal were the internal shell with items hidden, then every future
 * internal destination would be one forgotten filter away from appearing in it. Here there
 * is no filter to forget: `CLIENT_NAVIGATION` is the only list this component can render.
 *
 * The client's own name leads the header, with the delivery team named beneath it. That is
 * `22` §3's rule for `ID-03` — "Client invitation prominently states 'client portal access,'
 * not team membership" — carried through to the portal itself, so a client always knows
 * whose space they are in and who is delivering to them.
 */
export function ClientPortalShell({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  projectName,
  activeNavigationId,
  title,
  eyebrow,
  description,
  headerAside,
  children,
  preview = false,
}: ClientPortalShellProps) {
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  return (
    <LiveAnnouncer>
      <div className="tm-portal" data-preview={preview ? 'true' : undefined}>
        <SkipLink targetId="tm-main" />

        {preview ? (
          <div className="tm-portal__preview-bar">
            <StatusDot tone="client">Client preview</StatusDot>
            <p className="tm-portal__preview-note">
              This is what {clientName} sees. Nothing here is internal.
            </p>
          </div>
        ) : null}

        {/* CL-01: one light bar — the brand orb with the client and their delivery team, the
            portal's destinations as capsules, and the audience/project context at the end. */}
        <header className="tm-portal__header">
          <div className="tm-portal__identity">
            <span className="tm-portal__mark">
              <Wordmark variant="icon" label="TManage" />
            </span>
            <div>
              <p className="tm-portal__client">{clientName}</p>
              <p className="tm-portal__provider">Delivered by {providerName}</p>
            </div>
          </div>

          <nav className="tm-portal__nav" aria-label="Primary">
            <ul className="tm-portal__nav-list">
              {CLIENT_NAVIGATION.map((item) => {
                const current = item.id === activeNavigationId;
                return (
                  <li key={item.id}>
                    <Link
                      href={`/${organizationSlug}${item.href}`}
                      className="tm-portal__nav-item"
                      {...(current ? { 'aria-current': 'page' as const } : {})}
                    >
                      <span className="tm-portal__nav-glyph" aria-hidden="true">
                        {item.glyph}
                      </span>
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="tm-portal__context">
            <Badge tone="client" mono>
              Client portal
            </Badge>
          </div>
        </header>

        <main id="tm-main" className="tm-portal__canvas" tabIndex={-1}>
          <div className="tm-portal__page-head">
            <div className="tm-portal__titles">
              {eyebrow || projectName ? (
                <p className="tm-portal__eyebrow">{eyebrow ?? projectName}</p>
              ) : null}
              <h1 className="tm-portal__title">{title}</h1>
              {description ? <p className="tm-portal__description">{description}</p> : null}
            </div>
            {headerAside ? <div className="tm-portal__aside">{headerAside}</div> : null}
          </div>
          {children}
        </main>
      </div>
    </LiveAnnouncer>
  );
}
