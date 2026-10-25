'use client';

import Link from '../../website/WebLink';
import type { ReactNode } from 'react';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../../brand/Wordmark';
import { useInWebsiteChrome } from '../../website/WebsiteChrome';
import type { MessageKey } from '../../../lib/i18n/t';
import { useT } from '../../../lib/i18n/use-t';
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

const SECTIONS: readonly { id: PublicSection; labelKey: MessageKey; href: string }[] = [
  { id: 'product', labelKey: 'PublicSite.navProduct', href: '/#product' },
  { id: 'portal', labelKey: 'PublicSite.navPortal', href: '/#portal' },
  { id: 'pricing', labelKey: 'PublicSite.navPricing', href: '/pricing' },
  { id: 'security', labelKey: 'PublicSite.navSecurity', href: '/security' },
  { id: 'status', labelKey: 'PublicSite.navStatus', href: '/status' },
];

export function PublicPage({
  children,
  current,
  bar = 'marketing',
  statusMeta,
  tone = 'default',
  width = 'wide',
}: PublicPageProps) {
  const t = useT();
  const inWebsite = useInWebsiteChrome();
  if (inWebsite) {
    // Inside the `(website)` route group the shared Web/Nav, `<main>` and Web/Footer already
    // frame the page (components/website/WebsiteChrome.tsx), so only the content renders here.
    return (
      <div className={`tm-pub${tone === 'paper' ? ' tm-pub--paper' : ''}`}>
        <div className={`tm-pub__inner${width === 'narrow' ? ' tm-pub__inner--narrow' : ''}`}>
          {bar === 'status' ? (
            <div className="tm-pub__bar tm-pub__bar--status">
              <p className="tm-pub-eyebrow">{t('PublicSite.statusEyebrow')}</p>
              {statusMeta ? <p className="tm-pub__bar-meta">{statusMeta}</p> : null}
            </div>
          ) : null}
          <div className="tm-pub__main">{children}</div>
        </div>
      </div>
    );
  }
  return (
    <LiveAnnouncer label={t('Shell.liveAnnouncements')}>
      <div className={`tm-pub${tone === 'paper' ? ' tm-pub--paper' : ''}`}>
        <SkipLink targetId="tm-main">{t('Shell.skipLink')}</SkipLink>
        <div className={`tm-pub__inner${width === 'narrow' ? ' tm-pub__inner--narrow' : ''}`}>
          {bar === 'status' ? (
            <header className="tm-pub__bar tm-pub__bar--status">
              <Link href="/" className="tm-pub__brand" aria-label={t('PublicSite.brandHome')}>
                <Wordmark label="TManage" />
              </Link>
              <p className="tm-pub-eyebrow">{t('PublicSite.statusEyebrow')}</p>
              {statusMeta ? <p className="tm-pub__bar-meta">{statusMeta}</p> : null}
            </header>
          ) : (
            <header className="tm-pub__bar">
              <Link href="/" className="tm-pub__brand" aria-label={t('PublicSite.brandHome')}>
                <Wordmark label="TManage" />
              </Link>
              <nav className="tm-pub__nav" aria-label={t('PublicSite.primaryNav')}>
                {SECTIONS.map((section) => (
                  <Link
                    key={section.id}
                    href={section.href}
                    className="tm-pub__nav-link"
                    aria-current={section.id === current ? 'page' : undefined}
                  >
                    {t(section.labelKey)}
                  </Link>
                ))}
              </nav>
              <div className="tm-pub__actions">
                <Link href="/sign-in" className="tm-pub__signin">
                  {t('PublicSite.signIn')}
                </Link>
                <OrbLink href="/sign-in">{t('PublicSite.startFree')}</OrbLink>
              </div>
            </header>
          )}

          <main id="tm-main" className="tm-pub__main" tabIndex={-1}>
            {children}
          </main>

          <footer className="tm-pub__footer">
            <Wordmark label="TManage" />
            <nav className="tm-pub__footer-nav" aria-label={t('PublicSite.footerNav')}>
              <Link href="/pricing">{t('PublicSite.footerPricing')}</Link>
              <Link href="/security">{t('PublicSite.footerSecurity')}</Link>
              <Link href="/resources">{t('PublicSite.footerResources')}</Link>
              <Link href="/faq">{t('PublicSite.footerFaq')}</Link>
              <Link href="/changelog">{t('PublicSite.footerChangelog')}</Link>
              <Link href="/contact">{t('PublicSite.footerContact')}</Link>
              <Link href="/legal/privacy">{t('PublicSite.footerPrivacy')}</Link>
              <Link href="/legal/terms">{t('PublicSite.footerTerms')}</Link>
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
