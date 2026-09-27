import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { INTERNAL_NAVIGATION } from './navigation';
import { MaintenanceBanner } from '../screens/MaintenanceBanner';
import { CommandPalette } from '../screens/CommandPalette';

export interface AppShellProps {
  /**
   * The organization the person is working in, as it appears in a URL.
   *
   * Every rail destination lives under it — `INTERNAL_NAVIGATION` carries the suffix and this
   * supplies the prefix — for the reason `ClientPortalShell` gives: every screen is
   * tenant-scoped, and the slug in the path is the claim the API's `TenantContextGuard`
   * resolves against a membership row. The rail carried org-less hrefs from WEB-001 until
   * 2026-09-03, so its links pointed at routes that do not exist.
   */
  organizationSlug: string;
  /** The organization the person is working in. Always visible — `22` §1 requires it. */
  organizationName: string;
  /** The id of the rail destination that is current, e.g. `work`. */
  activeNavigationId?: string;
  /** The screen title. Rendered as the one `<h1>` of the document. */
  title: string;
  /** Optional supporting line beneath the title. */
  description?: ReactNode;
  /** Actions belonging to the whole screen, rendered at the end of the canvas header. */
  actions?: ReactNode;
  /** The contextual sidebar — saved views, channels, admin sections. */
  contextRail?: ReactNode;
  children: ReactNode;
  /** The optional detail pane, the "context lens" in the design language. */
  lens?: ReactNode;
}

/**
 * The internal shell: orbital rail, contextual sidebar, canvas, optional detail pane.
 *
 * This is the first of the two shells `22-SCREEN-BY-SCREEN` §1 defines. It is built now,
 * ahead of the screens that will fill it, because WEB-001 stands up the application and a
 * shell that arrives with the first internal screen is a shell designed around one screen.
 *
 * Three decisions worth stating:
 *
 * 1. **The rail is a `<nav>` with a list, and every destination is a real `<a>`.** The
 *    export draws it as a column of orbs; an orb that is a `<button>` with an onClick is not
 *    reachable by middle-click, cannot be opened in a new tab, and tells a screen reader
 *    nothing about where it goes. The orb is the appearance, the link is the element.
 * 2. **The organization name is in the shell, not in each screen.** `22` §1: "All screens
 *    expose current organization/project and audience context." Putting it here means no
 *    screen can omit it.
 * 3. **`aria-current="page"`** marks the active destination rather than a class alone, so
 *    the state that is communicated by colour is also communicated to assistive technology.
 *    That is law 3 of the token export — every state that uses colour also carries a word.
 */
export function AppShell({
  organizationSlug,
  organizationName,
  activeNavigationId,
  title,
  description,
  actions,
  contextRail,
  children,
  lens,
}: AppShellProps) {
  return (
    <LiveAnnouncer>
      <div className="tm-app">
        <SkipLink targetId="tm-main" />

        {/* Platform states (x185): the maintenance / degraded-mode banner. Reads the public
            endpoint and renders nothing unless a window is active, so every internal screen shares
            it at no cost when the platform is healthy. */}
        <MaintenanceBanner />
        {/* SRCH command palette (x181): keyboard-driven (Ctrl/Cmd-K) navigation and quick actions
            over the existing search. Rendered once here so every internal screen shares it. */}
        <CommandPalette organizationSlug={organizationSlug} />

        <nav className="tm-rail" aria-label="Primary">
          <Link href={`/${organizationSlug}/home`} className="tm-rail__brand">
            <Wordmark variant="icon" label="TManage home" />
          </Link>

          <ul className="tm-rail__list">
            {INTERNAL_NAVIGATION.map((item) => {
              const current = item.id === activeNavigationId;
              return (
                <li key={item.id}>
                  <Link
                    href={`/${organizationSlug}${item.href}`}
                    className="tm-rail__item"
                    {...(current ? { 'aria-current': 'page' as const } : {})}
                  >
                    <span className="tm-rail__orb" aria-hidden="true">
                      {item.glyph}
                    </span>
                    <span className="tm-rail__label">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="tm-app__body">
          <header className="tm-canvas-header">
            <div className="tm-canvas-header__context">
              <Badge mono>{organizationName}</Badge>
              <Badge mono>Internal</Badge>
            </div>
            <div className="tm-canvas-header__titles">
              <h1 className="tm-canvas-header__title">{title}</h1>
              {description ? <p className="tm-canvas-header__description">{description}</p> : null}
            </div>
            {actions ? <div className="tm-canvas-header__actions">{actions}</div> : null}
          </header>

          <div className="tm-app__columns">
            {contextRail ? (
              <nav className="tm-context-rail" aria-label="Within this section">
                {contextRail}
              </nav>
            ) : null}

            <main id="tm-main" className="tm-canvas" tabIndex={-1}>
              {children}
            </main>

            {lens ? (
              <aside className="tm-lens" aria-label="Details">
                {lens}
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </LiveAnnouncer>
  );
}
