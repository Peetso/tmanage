'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { LiveAnnouncer, SkipLink } from '@tmanage/ui';
import { WebNav } from './WebNav';
import { WebFooter } from './WebFooter';
import { useT } from '../../lib/i18n/use-t';
import './website.css';

/**
 * True inside the public website's chrome. Screens that still carry their own public bar
 * (`PublicPage` in `screens/public/PublicSite.tsx`) read it and render only their content, so
 * the site has exactly one nav, one `<main>` and one footer.
 */
const WebsiteChromeContext = createContext(false);

export function useInWebsiteChrome(): boolean {
  return useContext(WebsiteChromeContext);
}

const CURRENT_BY_PREFIX: readonly [string, string][] = [
  ['/product', 'product'],
  ['/features', 'product'],
  ['/solutions', 'solutions'],
  ['/client-portal', 'client-portal'],
  ['/pricing', 'pricing'],
  ['/resources', 'resources'],
  ['/faq', 'resources'],
  ['/status', 'resources'],
];

function currentEntry(pathname: string | null): string | undefined {
  if (!pathname) return undefined;
  return CURRENT_BY_PREFIX.find(([prefix]) => pathname.startsWith(prefix))?.[1];
}

/**
 * The website shell for the `(website)` route group: skip link, Web/Nav, one `<main>`,
 * Web/Footer. Pages render their sections straight into `<main>`; the closing Web/CTA band is
 * the page's choice, not the shell's.
 */
export function WebsiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useT();
  return (
    <WebsiteChromeContext.Provider value>
      <LiveAnnouncer>
        <div className="tm-web">
          <SkipLink targetId="tm-web-main">{t('WebsiteChrome.skipLink')}</SkipLink>
          <WebNav current={currentEntry(pathname)} />
          <main id="tm-web-main" className="tm-web__main" tabIndex={-1}>
            {children}
          </main>
          <WebFooter />
        </div>
      </LiveAnnouncer>
    </WebsiteChromeContext.Provider>
  );
}
