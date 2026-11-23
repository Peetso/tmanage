'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useT } from '../../lib/i18n/use-t';
import { GettingStartedLauncher } from '../onboarding/GettingStartedCard';
import { AutoTimerStatus } from '../time/AutoTimerStatus';
import { RunningTimerPill } from '../time/TimerControls';
import { BetaTag } from './BetaTag';
import { FeatureOn } from './FeatureOn';
import './compact-header.css';

/**
 * The shell's state controls that stay in a compact header: the running-timer pill and the
 * automatic timer (only while a timer runs) and the getting-started checklist (until dismissed).
 * Each draws nothing in its resting state, so the header holds only what the design draws.
 */
export function ShellStateControls({ organizationSlug }: { organizationSlug: string }) {
  return (
    <>
      <FeatureOn organizationSlug={organizationSlug} flag="time_tracking">
        <RunningTimerPill organizationSlug={organizationSlug} />
        <AutoTimerStatus organizationSlug={organizationSlug} />
      </FeatureOn>
      <GettingStartedLauncher organizationSlug={organizationSlug} />
    </>
  );
}

export interface CompactLayoutProps {
  readonly organizationName: string;
  readonly title: ReactNode;
  readonly titleMeta?: ReactNode;
  readonly actions?: ReactNode;
  readonly crumbs?: ReactNode;
  readonly crumbActions?: ReactNode;
  readonly back?: { readonly href: string; readonly label: string } | undefined;
  readonly description?: ReactNode;
  readonly contextRail?: ReactNode;
  readonly lens?: ReactNode;
  readonly topBar?: ReactNode;
  readonly phoneHeader: 'show' | 'hide';
  readonly children: ReactNode;
}

/**
 * The compact page header and columns of Work area v2 (Figma `WV2-01`, `WV2-02`, `WV2-05`,
 * `WV2-08`; WORK-BUILD-FABLE-REVIEW must-fix 3, 4 and 13; UX-27 "one header row").
 *
 * - **One 56px header row** (`--app-header-row`): the title, the count on the title's line, then
 *   the screen's own controls at the end, and a 1px line under it. The row does not wrap, so the
 *   count cannot drop under the title. A detail page puts its plain trail ("Website relaunch ›
 *   Work", sentence case, no leading dot) in that row with the row's controls; its title row
 *   follows under the line.
 * - **The header starts beside the context rail**, which runs the full height of the page.
 * - **The shell adds nothing the design does not draw**: no "+ New", Help or "Let AI do the job"
 *   in the row. Help and AI sit at the foot of the rail, or in the phone top bar (AppShell's
 *   `tm-shell-tools`); "+ New" stays on every other screen, on the phone dock's "+" and in the
 *   command palette.
 * - **Phone**: the organization line and the shell's orbs make one top bar; a detail page shows a
 *   back link in place of the trail; a screen that draws its own back link and title drops the
 *   header (`phoneHeader="hide"`).
 */
export function CompactLayout({
  organizationName,
  title,
  titleMeta,
  actions,
  crumbs,
  crumbActions,
  back,
  description,
  contextRail,
  lens,
  topBar,
  phoneHeader,
  children,
}: CompactLayoutProps) {
  const t = useT();
  return (
    <>
      {/* The phone top bar's organization line (Figma 406:6389). On a desktop the design names the
          organization by the rail's brand orb, so the line is kept for assistive technology. */}
      <p className="tm-compact-org">
        <BetaTag placement="phone" />
        <span className="tm-compact-org__name">{organizationName}</span>
      </p>
      <div className="tm-app__columns" data-layout="compact">
        {contextRail ? (
          <nav className="tm-context-rail" aria-label={t('shell.rail.sectionNav')}>
            {contextRail}
          </nav>
        ) : null}

        <div className="tm-app__pane">
          <header
            className="tm-canvas-header tm-compact-header"
            data-title-variant="page"
            data-actions="end"
            data-trail={crumbs || crumbActions ? 'true' : undefined}
            data-phone={phoneHeader === 'hide' ? 'hidden' : undefined}
          >
            {crumbs || crumbActions ? (
              <div className="tm-compact-header__trail-row">
                {crumbs ? (
                  <nav className="tm-compact-header__trail" aria-label={t('shell.breadcrumb')}>
                    {crumbs}
                  </nav>
                ) : null}
                {back ? (
                  <Link className="tm-compact-header__back" href={back.href}>
                    <span aria-hidden="true" className="tm-compact-header__back-icon">
                      ‹
                    </span>
                    <span>{back.label}</span>
                  </Link>
                ) : null}
                {crumbActions ? (
                  <div className="tm-canvas-header__actions">{crumbActions}</div>
                ) : null}
              </div>
            ) : null}
            <div className="tm-canvas-header__title-row tm-compact-header__title-row">
              <h1 className="tm-canvas-header__title">{title}</h1>
              {titleMeta ? <span className="tm-canvas-header__meta">{titleMeta}</span> : null}
              {actions ? <div className="tm-canvas-header__actions">{actions}</div> : null}
            </div>
            {description ? <p className="tm-canvas-header__description">{description}</p> : null}
          </header>

          {topBar ? <div className="tm-app__topbar">{topBar}</div> : null}

          <div className="tm-app__pane-body">
            <main id="tm-main" className="tm-canvas" tabIndex={-1}>
              {children}
            </main>
            {lens ? (
              <aside className="tm-lens" aria-label={t('shell.lens.details')}>
                {lens}
              </aside>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
