import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, SkipLink, StatusDot } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { CLIENT_NAVIGATION } from './navigation';

export interface ClientPortalShellProps {
  /** The client organization whose portal this is. Their name leads, not the vendor's. */
  clientName: string;
  /** The delivery team's name, shown as the smaller "delivered by" line. */
  providerName: string;
  /** The project, when the portal is scoped to one. `22` §1: "project selector if authorized". */
  projectName?: string;
  activeNavigationId?: string;
  title: string;
  description?: ReactNode;
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
  clientName,
  providerName,
  projectName,
  activeNavigationId,
  title,
  description,
  children,
  preview = false,
}: ClientPortalShellProps) {
  return (
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

      <header className="tm-portal__header">
        <div className="tm-portal__identity">
          <p className="tm-portal__client">{clientName}</p>
          <p className="tm-portal__provider">
            Delivered by {providerName} <Wordmark variant="icon" label="on TManage" />
          </p>
        </div>

        <div className="tm-portal__context">
          <Badge tone="client" mono>
            Client portal
          </Badge>
          {projectName ? <Badge mono>{projectName}</Badge> : null}
        </div>
      </header>

      <nav className="tm-portal__nav" aria-label="Primary">
        <ul className="tm-portal__nav-list">
          {CLIENT_NAVIGATION.map((item) => {
            const current = item.id === activeNavigationId;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
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

      <main id="tm-main" className="tm-portal__canvas" tabIndex={-1}>
        <h1 className="tm-portal__title">{title}</h1>
        {description ? <p className="tm-portal__description">{description}</p> : null}
        {children}
      </main>
    </div>
  );
}
