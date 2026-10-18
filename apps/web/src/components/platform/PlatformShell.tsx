'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import '../../styles/screens/admin.css';

/** The Platform admin destinations the section map can mark as current. */
export type PlatformSection = 'overview' | 'companies' | 'people' | 'settings' | 'audit';

const SECTIONS: readonly { id: PlatformSection; label: string; href: string }[] = [
  { id: 'overview', label: 'Overview', href: '/platform' },
  { id: 'companies', label: 'Companies', href: '/platform/companies' },
  { id: 'people', label: 'People', href: '/platform/people' },
  { id: 'settings', label: 'Settings', href: '/platform/settings' },
  { id: 'audit', label: 'Audit log', href: '/platform/audit' },
];

export interface PlatformShellProps {
  section: PlatformSection;
  /** The breadcrumb after "Platform admin". */
  crumbs: readonly string[];
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * The Platform admin frame — the Control Center's layout (`ControlCenterShell` on `AppShell`)
 * without an organization. The operator is not working inside any company, so the rail holds
 * only the brand and the Platform orb, the eyebrow reads "TManage · Platform admin / …", and
 * the left column is the platform's own section map in the Control Center's classes. No new
 * visual language: every class here is the shell's or the Control Center's.
 */
export function PlatformShell({
  section,
  crumbs,
  title,
  description,
  actions,
  children,
}: PlatformShellProps) {
  return (
    <LiveAnnouncer>
      <div className="tm-app">
        <SkipLink targetId="tm-main" />
        <div className="tm-app__frame">
          <nav className="tm-rail" aria-label="Primary">
            <Link href="/organizations" className="tm-rail__brand">
              <Wordmark variant="icon" label="Your organizations" />
            </Link>
            <span className="tm-rail__rule" aria-hidden="true" />
            <ul className="tm-rail__list">
              <li>
                <Link href="/platform" className="tm-rail__item" aria-current="page">
                  <span className="tm-rail__orb" aria-hidden="true">
                    ⚙
                  </span>
                  <span className="tm-rail__label">Platform</span>
                </Link>
              </li>
            </ul>
          </nav>

          <div className="tm-app__body">
            <header className="tm-canvas-header" data-title-variant="page" data-actions="end">
              <div className="tm-canvas-header__titles">
                <p className="tm-canvas-header__context">
                  <span className="tm-canvas-header__org">TManage</span>
                  <span aria-hidden="true"> · </span>
                  <span>{['Platform admin', ...crumbs].join(' / ')}</span>
                </p>
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
              <nav className="tm-context-rail" aria-label="Within this section">
                <div className="tm-cc-sections">
                  <div>
                    <p className="tm-cc-sections__label">Platform admin</p>
                    <ul className="tm-cc-sections__group">
                      {SECTIONS.map((item) => (
                        <li key={item.id}>
                          <Link
                            href={item.href}
                            className="tm-cc-sections__item"
                            {...(item.id === section ? { 'aria-current': 'page' as const } : {})}
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
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
