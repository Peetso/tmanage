'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { englishBootTitle } from '../../lib/i18n/locale-boot';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { englishRouteTitle, localizedRouteTitle } from '../../lib/route-titles';

/** The root layout's default title, which a route without its own `metadata` is left with. */
const BARE_TITLE = 'TManage';

/** The last title this component wrote, kept across routes so a client navigation replaces it. */
let lastWritten: string | undefined;

/**
 * Gives every route its page name in the tab, in the active locale (live check f30af1d0, E1).
 *
 * Mounted once in the root layout. It only ever replaces a title that is the bare `TManage`, the
 * route's own English name (what the server sent) or the last one it wrote (on any route), so a page that sets its
 * own title (an article, the home page's hero line, a website page `WebsiteDocumentTitle` has
 * already translated) is left alone. A `MutationObserver` on `<head>` catches Next rewriting the
 * title after a client navigation.
 */
export function RouteDocumentTitle() {
  const pathname = usePathname();
  const locale = useActiveLocale();

  useEffect(() => {
    if (!pathname) return undefined;
    const target = localizedRouteTitle(pathname, locale);
    if (target === undefined) return undefined;
    const english = englishRouteTitle(pathname);

    const apply = () => {
      const current = document.title;
      // The boot script's Arabic swap of the English title counts as the route's own title too.
      const ours =
        current === BARE_TITLE ||
        current === english ||
        current === lastWritten ||
        (english !== undefined && englishBootTitle(current) === english);
      if (!ours || current === target) return;
      lastWritten = target;
      document.title = target;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname, locale]);

  return null;
}
