'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink, StatusDot } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import type { PlatformMeView } from '../../lib/api/platform-admin';
import '../../styles/screens/admin.css';

/**
 * The seven Platform admin sections (platform-admin v2, fixed in wave 1; Figma 432:10164):
 * Overview · Organizations · People · Content · Activity · Settings · Team.
 */
export type PlatformSection =
  'overview' | 'organizations' | 'people' | 'content' | 'activity' | 'settings' | 'team';

/**
 * Section ids the screens used before v2. Still accepted so a screen an area slice has not yet
 * replaced keeps compiling; each maps onto its v2 section.
 */
export type LegacyPlatformSection = 'companies' | 'audit' | 'ai-access';

const LEGACY: Record<LegacyPlatformSection, PlatformSection> = {
  companies: 'organizations',
  audit: 'activity',
  'ai-access': 'settings',
};

/** The sub-page of a section, marked in the section's own list (Team: admins / presets). */
export type PlatformSubsection = 'team-admins' | 'team-presets';

const SECTIONS: readonly { id: PlatformSection; labelKey: MessageKey; href: string }[] = [
  { id: 'overview', labelKey: 'PlatformShell.overview', href: '/platform' },
  { id: 'organizations', labelKey: 'PlatformShell.organizations', href: '/platform/organizations' },
  { id: 'people', labelKey: 'PlatformShell.people', href: '/platform/people' },
  // Content lives under an organization (B5); the entry opens the organizations list.
  { id: 'content', labelKey: 'PlatformShell.content', href: '/platform/organizations' },
  { id: 'activity', labelKey: 'PlatformShell.activity', href: '/platform/activity' },
  { id: 'settings', labelKey: 'PlatformShell.settings', href: '/platform/settings' },
  { id: 'team', labelKey: 'PlatformShell.team', href: '/platform/team' },
];

const TEAM_PAGES: readonly { id: PlatformSubsection; labelKey: MessageKey; href: string }[] = [
  { id: 'team-admins', labelKey: 'PlatformShell.teamAdmins', href: '/platform/team' },
  { id: 'team-presets', labelKey: 'PlatformShell.teamPresets', href: '/platform/team/presets' },
];

const PRESET_KEYS: Record<PlatformMeView['preset'], MessageKey> = {
  super_admin: 'PlatformShell.presetSuperAdmin',
  support: 'PlatformShell.presetSupport',
  auditor: 'PlatformShell.presetAuditor',
  custom: 'PlatformShell.presetCustom',
};

export interface PlatformShellProps {
  section: PlatformSection | LegacyPlatformSection;
  subsection?: PlatformSubsection;
  /** The breadcrumb after "Platform admin". */
  crumbs: readonly string[];
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** The signed-in admin: the step-up pill and the admin card. Absent while `me` loads. */
  me?: PlatformMeView;
  children: ReactNode;
}

/** Minutes left on the step-up, refreshed every 15 s; `null` when none is live. */
function useStepUpMinutesLeft(expiresAt: string | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(left) || left <= 0) return null;
  return Math.max(1, Math.ceil(left / 60_000));
}

/**
 * The Platform admin frame — the Control Center's layout without an organization. The rail holds
 * the brand and the Platform orb; the header carries the breadcrumb and the step-up pill (432:10222);
 * the left column is the platform's section map with the signed-in admin card at its foot
 * (432:10164). Every class here is the shell's or the Control Center's.
 */
export function PlatformShell({
  section: rawSection,
  subsection,
  crumbs,
  title,
  description,
  actions,
  me,
  children,
}: PlatformShellProps) {
  const t = useT();
  const section: PlatformSection =
    rawSection in LEGACY
      ? LEGACY[rawSection as LegacyPlatformSection]
      : (rawSection as PlatformSection);
  const minutesLeft = useStepUpMinutesLeft(me?.stepUpExpiresAt);

  const stepUpPill = me ? (
    <span
      className={minutesLeft === null ? 'tm-cc-pill tm-cc-pill--warning' : 'tm-cc-pill'}
      data-testid="platform-step-up-pill"
    >
      <StatusDot tone={minutesLeft === null ? 'warning' : 'success'}>
        {minutesLeft === null
          ? t('PlatformShell.stepUpNeeded')
          : `${t('PlatformShell.stepUpValid')} · ${minutesLeft} ${t('PlatformShell.minLeft')}`}
      </StatusDot>
    </span>
  ) : null;

  return (
    <LiveAnnouncer label={t('Shell.liveAnnouncements')}>
      <div className="tm-app">
        <SkipLink targetId="tm-main">{t('Shell.skipLink')}</SkipLink>
        <div className="tm-app__frame">
          <nav className="tm-rail" aria-label={t('PlatformShell.ariaPrimary')}>
            <Link href="/organizations" className="tm-rail__brand">
              <Wordmark variant="icon" label={t('PlatformShell.yourOrganizations')} />
            </Link>
            <span className="tm-rail__rule" aria-hidden="true" />
            <ul className="tm-rail__list">
              <li>
                <Link href="/platform" className="tm-rail__item" aria-current="page">
                  <span className="tm-rail__orb" aria-hidden="true">
                    ⚙
                  </span>
                  <span className="tm-rail__label">{t('PlatformShell.platform')}</span>
                </Link>
              </li>
            </ul>
          </nav>

          <div className="tm-app__body">
            <header className="tm-canvas-header" data-title-variant="page" data-actions="end">
              <div className="tm-canvas-header__titles">
                <div className="tm-cc-hero__actions" style={{ justifyContent: 'space-between' }}>
                  <p className="tm-canvas-header__context">
                    <span className="tm-canvas-header__org">TManage</span>
                    <span aria-hidden="true"> · </span>
                    <span>{[t('PlatformShell.platformAdmin'), ...crumbs].join(' / ')}</span>
                  </p>
                  {stepUpPill}
                </div>
                <div className="tm-canvas-header__title-row">
                  <h1 className="tm-canvas-header__title">{title}</h1>
                  {actions ? <div className="tm-canvas-header__actions">{actions}</div> : null}
                </div>
                {description ? (
                  <p className="tm-canvas-header__description">{description}</p>
                ) : null}
              </div>
            </header>

            <div className="tm-app__columns">
              <nav className="tm-context-rail" aria-label={t('PlatformShell.withinSection')}>
                <div className="tm-cc-sections">
                  <div>
                    <p className="tm-cc-sections__label">{t('PlatformShell.platformLabel')}</p>
                    <ul className="tm-cc-sections__group">
                      {SECTIONS.map((item) => (
                        <li key={item.id}>
                          <Link
                            href={item.href}
                            className="tm-cc-sections__item"
                            {...(item.id === section && subsection === undefined
                              ? { 'aria-current': 'page' as const }
                              : item.id === section
                                ? { 'aria-current': 'true' as const }
                                : {})}
                          >
                            {t(item.labelKey)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {section === 'team' ? (
                    <div>
                      <p className="tm-cc-sections__label">{t('PlatformShell.teamLabel')}</p>
                      <ul className="tm-cc-sections__group">
                        {TEAM_PAGES.map((item) => (
                          <li key={item.id}>
                            <Link
                              href={item.href}
                              className="tm-cc-sections__item"
                              {...((subsection ?? 'team-admins') === item.id
                                ? { 'aria-current': 'page' as const }
                                : {})}
                            >
                              {t(item.labelKey)}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {me ? (
                    <div
                      className="tm-cc-card tm-cc-card--quiet tm-stack tm-stack--tight"
                      aria-label={t('PlatformShell.signedInAs')}
                      role="group"
                    >
                      <p className="tm-cc-eyebrow">{t('PlatformShell.platformAdmin')}</p>
                      <bdi dir="ltr" className="tm-cc-cell-title">
                        {me.email}
                      </bdi>
                      <span className="tm-cc-cell-sub">
                        {t(PRESET_KEYS[me.preset])}
                        {me.source === 'env' ? ` · ${t('PlatformShell.bootstrapEnv')}` : ''}
                      </span>
                    </div>
                  ) : null}
                </div>
              </nav>

              <main id="tm-main" className="tm-canvas" tabIndex={-1}>
                {children}
              </main>
            </div>
          </div>
        </div>
      </div>
    </LiveAnnouncer>
  );
}
