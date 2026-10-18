'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../../brand/Wordmark';
import '../../../styles/screens/public.css';

/**
 * The public site's chrome — PUB-01's bar (wordmark, five section links, Sign in, the black
 * "Start free" capsule with its orb) and a quiet footer, around one `<main>`.
 *
 * Every public page (`/`, `/pricing`, `/security`, `/status`, `/faq`, `/changelog`, `/contact`,
 * `/resources`, `/legal/*`) has no tenant and no session, so none of them can borrow `AppShell`.
 * This component owns the A11Y-01 landmarks for all of them — skip link, banner, one `<main>`,
 * content info — so each screen only owns its one `<h1>` and its content.
 *
 * `bar="status"` is PUB-07's own header (wordmark, STATUS eyebrow, the freshness line on the
 * right) instead of the marketing bar.
 */
export interface PublicPageProps {
  children: ReactNode;
  /** Which bar link is the current page (`aria-current="page"`). */
  current?: PublicSection;
  /** `marketing` (default) is PUB-01's bar; `status` is PUB-07's slim header. */
  bar?: 'marketing' | 'status';
  /** PUB-07's right-hand freshness line, shown in the status bar only. */
  statusMeta?: ReactNode;
  /** `paper` paints the page `--paper-50` (PUB-03); default is `--paper-150`. */
  tone?: 'default' | 'paper';
  /** Narrower canvas for the 1200-wide frames (PUB-06, PUB-07). */
  width?: 'wide' | 'narrow';
}

export type PublicSection = 'product' | 'portal' | 'pricing' | 'security' | 'status';

const SECTIONS: readonly { id: PublicSection; label: string; href: string }[] = [
  { id: 'product', label: 'Product', href: '/#product' },
  { id: 'portal', label: 'Client Portal', href: '/#portal' },
  { id: 'pricing', label: 'Pricing', href: '/pricing' },
  { id: 'security', label: 'Security', href: '/security' },
  { id: 'status', label: 'Status', href: '/status' },
];

export function PublicPage({
  children,
  current,
  bar = 'marketing',
  statusMeta,
  tone = 'default',
  width = 'wide',
}: PublicPageProps) {
  return (
    <LiveAnnouncer>
      <div className={`tm-pub${tone === 'paper' ? ' tm-pub--paper' : ''}`}>
        <SkipLink targetId="tm-main" />
        <div className={`tm-pub__inner${width === 'narrow' ? ' tm-pub__inner--narrow' : ''}`}>
          {bar === 'status' ? (
            <header className="tm-pub__bar tm-pub__bar--status">
              <Link href="/" className="tm-pub__brand" aria-label="TManage home">
                <Wordmark label="TManage" />
              </Link>
              <p className="tm-pub-eyebrow">Status</p>
              {statusMeta ? <p className="tm-pub__bar-meta">{statusMeta}</p> : null}
            </header>
          ) : (
            <header className="tm-pub__bar">
              <Link href="/" className="tm-pub__brand" aria-label="TManage home">
                <Wordmark label="TManage" />
              </Link>
              <nav className="tm-pub__nav" aria-label="Primary">
                {SECTIONS.map((section) => (
                  <Link
                    key={section.id}
                    href={section.href}
                    className="tm-pub__nav-link"
                    aria-current={section.id === current ? 'page' : undefined}
                  >
                    {section.label}
                  </Link>
                ))}
              </nav>
              <div className="tm-pub__actions">
                <Link href="/sign-in" className="tm-pub__signin">
                  Sign in
                </Link>
                <OrbLink href="/sign-in">Start free</OrbLink>
              </div>
            </header>
          )}

          <main id="tm-main" className="tm-pub__main" tabIndex={-1}>
            {children}
          </main>

          <footer className="tm-pub__footer">
            <Wordmark label="TManage" />
            <nav className="tm-pub__footer-nav" aria-label="Site">
              <Link href="/pricing">Pricing</Link>
              <Link href="/security">Security</Link>
              <Link href="/resources">Resources</Link>
              <Link href="/faq">FAQ</Link>
              <Link href="/changelog">Changelog</Link>
              <Link href="/contact">Contact</Link>
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/terms">Terms</Link>
            </nav>
          </footer>
        </div>
      </div>
    </LiveAnnouncer>
  );
}

/**
 * PUB-01's black capsule with a round orb at its start ("Start free", "Watch the work story").
 * `size="lg"` is the hero's larger one with the lime orb.
 */
export function OrbLink({
  href,
  children,
  size = 'md',
}: {
  href: string;
  children: ReactNode;
  size?: 'md' | 'lg';
}) {
  return (
    <Link href={href} className={`tm-pub-orb${size === 'lg' ? ' tm-pub-orb--lg' : ''}`}>
      <span className="tm-pub-orb__dot" aria-hidden="true">
        ▸
      </span>
      <span>{children}</span>
    </Link>
  );
}

/** The left-column intro every content page opens with: mono eyebrow, display line, lede. */
export function PublicIntro({
  eyebrow,
  title,
  titleId,
  size = 'sm',
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  titleId?: string;
  size?: 'xl' | 'lg' | 'md' | 'sm' | 'xs';
  children?: ReactNode;
}) {
  return (
    <header className="tm-pub-intro">
      <p className="tm-pub-eyebrow">{eyebrow}</p>
      <h1 id={titleId} className={`tm-pub-display tm-pub-display--${size}`}>
        {title}
      </h1>
      {children}
    </header>
  );
}
