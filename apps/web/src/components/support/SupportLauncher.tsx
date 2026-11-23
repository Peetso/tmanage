'use client';

import { useEffect, useId, useState } from 'react';
import { Button, Tooltip, MOTION_DELAY_TOOLTIP_MS } from '@tmanage/ui';
import { useHelpContextArticle } from '../help/HelpContextLink';
import { useTOr } from '../../lib/i18n/use-t-or';
import './support.css';

/**
 * Row 55-17 — the shell's help menu: the guide for this screen, the help centre, and "Contact
 * support", which leads to **Get help** (`/{orgSlug}/help`, 57-10) with the current page as
 * `?from=` so the person can send it along. An older reply e-mail's `?support=<threadId>` on any
 * page is forwarded to that request on Get help.
 */

const ID_PATTERN = /^[0-9a-f-]{36}$/iu;

export function getHelpHref(organizationSlug: string, from: string | null): string {
  const base = `/${encodeURIComponent(organizationSlug)}/help`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}

export function SupportLauncher({
  organizationSlug,
  pathname,
  variant = 'button',
}: {
  readonly organizationSlug: string;
  readonly pathname?: string;
  /** `orb`: My Day's "?" orb at the end of the day bar (spec MYDAY-V4 §4.1), named in a tooltip. */
  readonly variant?: 'button' | 'orb';
}) {
  const tOr = useTOr();
  const [menuOpen, setMenuOpen] = useState(false);
  const [from, setFrom] = useState<string | null>(pathname ?? null);
  const menuId = useId();
  const screenGuide = useHelpContextArticle(pathname);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (pathname === undefined) setFrom(window.location.pathname);
    const id = new URLSearchParams(window.location.search).get('support');
    if (id && ID_PATTERN.test(id)) {
      window.location.replace(
        `/${encodeURIComponent(organizationSlug)}/help?request=${encodeURIComponent(id)}`,
      );
    }
  }, [organizationSlug, pathname]);

  return (
    <div className="tm-support-launcher">
      {variant === 'orb' ? (
        <Tooltip
          content={tOr('MyDay.info.help', 'Help, shortcuts and the tour.')}
          delayMs={MOTION_DELAY_TOOLTIP_MS}
          placement="bottom"
        >
          <button
            type="button"
            className="tm-day-pulse__search tm-day-pulse__orb tm-support-launcher__trigger"
            aria-label={tOr('Support.menuLabel', 'Help')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">?</span>
          </button>
        </Tooltip>
      ) : (
        <Button
          tone="outline"
          size="default"
          className="tm-support-launcher__trigger"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {tOr('Support.menuLabel', 'Help')}
        </Button>
      )}
      {menuOpen ? (
        <ul id={menuId} role="menu" className="tm-support-menu">
          {/* FIX3 item 10: the guide for this screen (the old "?" beside the title) is the menu's
              first entry, so the header has one help button. */}
          {screenGuide ? (
            <li role="none">
              <a
                role="menuitem"
                className="tm-support-menu__item"
                href={screenGuide.href}
                target="_blank"
                rel="noopener noreferrer"
                data-help-slug={screenGuide.slug}
              >
                {tOr('Support.screenGuide', 'Guide for this screen')}
              </a>
            </li>
          ) : null}
          <li role="none">
            <a
              role="menuitem"
              className="tm-support-menu__item"
              href="/help"
              target="_blank"
              rel="noopener noreferrer"
            >
              {tOr('Support.helpCentre', 'Help centre')}
            </a>
          </li>
          <li role="none">
            <a
              role="menuitem"
              className="tm-support-menu__item tm-support-menu__item--accent"
              href={getHelpHref(organizationSlug, from)}
            >
              {tOr('Support.contact', 'Contact support')}
            </a>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
