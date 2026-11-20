'use client';

import { useEffect } from 'react';
import { carriedSignupParams, withCarriedSignupParams } from '../../lib/signup-attribution';

/**
 * ADTRACK without a cookie (NOCOOKIE): on a website page, a sign-up link carries on the `utm_*`
 * values and the `ref` invite code of the address the visitor arrived at, so the sign-up form
 * can send them (`lib/signup-attribution.ts`). Nothing is stored on the device: the values are
 * read from `location.search` and held in this component's memory only while the website stays
 * open in the tab (moving between website pages keeps the shell mounted); a reload starts again
 * from the address.
 *
 * One listener for every sign-up link the website renders (buttons, nav, footer, cards), so no
 * call site can forget it. The link's `href` is rewritten when a pointer, focus or context menu
 * reaches it (a new tab or a copied link gets the values too). A plain click is taken over and
 * sent to the rewritten address as a full page load: `next/link` would push its own `href` prop,
 * and the sign-up page has its own shell anyway. `navigate` is replaceable for tests only.
 */
/** Module-level, so the effect (and the landing values it holds) is set up once. */
const loadPage = (href: string): void => window.location.assign(href);

export function SignupLinkCarrier({
  navigate = loadPage,
}: {
  navigate?: (href: string) => void;
}): null {
  useEffect(() => {
    const landing = carriedSignupParams(window.location.search);
    const carried = () => {
      const here = carriedSignupParams(window.location.search);
      return here.length > 0 ? here : landing;
    };
    const decorate = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return undefined;
      const next = withCarriedSignupParams(
        anchor.getAttribute('href') ?? '',
        carried(),
        window.location.origin,
      );
      if (next === undefined) return undefined;
      anchor.setAttribute('href', next);
      return { anchor, next };
    };
    const onReach = (event: Event) => {
      decorate(event);
    };
    const onClick = (event: MouseEvent) => {
      const hit = decorate(event);
      if (
        hit === undefined ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        (hit.anchor.target !== '' && hit.anchor.target !== '_self') ||
        hit.anchor.hasAttribute('download')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      navigate(hit.next);
    };
    const reach = ['pointerdown', 'focusin', 'contextmenu'] as const;
    for (const type of reach) document.addEventListener(type, onReach, true);
    document.addEventListener('click', onClick, true);
    return () => {
      for (const type of reach) document.removeEventListener(type, onReach, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [navigate]);
  return null;
}
