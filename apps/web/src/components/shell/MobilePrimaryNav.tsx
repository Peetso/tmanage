'use client';

import { useCallback, useContext, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { MOBILE_DESTINATIONS, MOBILE_MORE_ITEM } from './navigation';
import { MoreSheet, OrbBadge } from './MoreSheet';
import { PhoneIcon } from '../icons/phone';
import { browserApiClient } from '../../lib/api/browser-client';
import { listInbox } from '../../lib/api/inbox';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/phone/shell.css';

/** The width the dock is drawn at — the same line as the `.tm-phone-dock` rule in `globals.css`. */
export const PHONE_DOCK_MEDIA_QUERY = '(max-width: 56.19rem)';

export interface MobilePrimaryNavProps {
  /**
   * The organization the person is working in, as it appears in a URL. Supplies the prefix
   * every destination's `href` suffix lives under, exactly as the orbital rail does in
   * `AppShell` — the dock is the same navigation at phone width, not a second one with its
   * own routes.
   */
  organizationSlug: string;
  /** The id of the destination that is current, e.g. `work`. */
  activeNavigationId?: string;
  /**
   * The Inbox badge. When omitted, the dock reads the inbox itself — only at phone width and
   * only with a `QueryClient` in the tree, so a desktop page never pays for a badge it hides.
   */
  inboxUnreadCount?: number;
  /** The Requests count on the More sheet; read live when omitted, as above. */
  requestsCount?: number;
}

function LiveInboxBadge({
  organizationSlug,
  describedById,
}: {
  organizationSlug: string;
  describedById: string;
}) {
  const inbox = useQuery({
    queryKey: ['shell', 'inbox-unread', organizationSlug],
    queryFn: () => listInbox(browserApiClient(), organizationSlug, { mode: 'all' }),
    staleTime: 60_000,
  });
  const count = inbox.data?.items.filter((item) => item.unreadCount > 0).length ?? 0;
  return <OrbBadge count={count} describedById={describedById} />;
}

/**
 * The phone tab bar (Figma ph-tabbar): a white pill of four destination orbs and "More", and
 * beside it the black quick-capture orb with its lime "+".
 *
 * 1. **Every destination is a real `<a>`**; "More" is a disclosure `<button>`, because it opens
 *    the sheet rather than going anywhere.
 * 2. **`aria-current="page"`** marks the active destination in a word, not only in colour. While
 *    the sheet is open the More orb is the inked one, as the ph-more frame draws it.
 * 3. **The Inbox badge** is described, not named: the link's name stays "Inbox".
 *
 * `globals.css` shows the dock only below ~900px and hides the orbital rail at that same
 * breakpoint, so the two never appear together.
 */
export function MobilePrimaryNav({
  organizationSlug,
  activeNavigationId,
  inboxUnreadCount,
  requestsCount,
}: MobilePrimaryNavProps) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useContext(QueryClientContext);
  const isPhone = useIsMobile(PHONE_DOCK_MEDIA_QUERY);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const sheetId = useId();
  const badgeId = useId();
  const base = `/${organizationSlug}`;

  const closeMore = useCallback(() => {
    setMoreOpen(false);
    moreRef.current?.focus();
  }, []);

  const inboxBadge =
    inboxUnreadCount !== undefined ? (
      <OrbBadge count={inboxUnreadCount} describedById={badgeId} />
    ) : queryClient && isPhone ? (
      <LiveInboxBadge organizationSlug={organizationSlug} describedById={badgeId} />
    ) : null;

  return (
    <div className="tm-phone-dock">
      <nav className="tm-mobile-nav" aria-label={t('shell.rail.mobilePrimary')}>
        <ul className="tm-mobile-nav__list">
          {MOBILE_DESTINATIONS.map((item) => {
            const current = !moreOpen && item.id === activeNavigationId;
            const isInbox = item.id === 'inbox';
            return (
              <li key={item.id}>
                <Link
                  href={`${base}${item.href}`}
                  className="tm-mobile-nav__item"
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                  {...(isInbox && inboxBadge ? { 'aria-describedby': badgeId } : {})}
                >
                  <span className="tm-mobile-nav__orb">
                    <span className="tm-mobile-nav__glyph" aria-hidden="true">
                      {item.glyph}
                    </span>
                    {item.phoneIcon ? <PhoneIcon name={item.phoneIcon} /> : null}
                    {isInbox ? inboxBadge : null}
                  </span>
                  <span className="tm-mobile-nav__label">{t(item.messageKey)}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              ref={moreRef}
              type="button"
              className="tm-mobile-nav__item"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-controls={moreOpen ? sheetId : undefined}
              data-active={moreOpen ? 'true' : undefined}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className="tm-mobile-nav__orb" aria-hidden="true">
                <span className="tm-mobile-nav__glyph">{MOBILE_MORE_ITEM.glyph}</span>
                <PhoneIcon name="more" />
              </span>
              <span className="tm-mobile-nav__label">
                {tOr(MOBILE_MORE_ITEM.messageKey, MOBILE_MORE_ITEM.label)}
              </span>
            </button>
          </li>
        </ul>
      </nav>
      <Link
        href={`${base}/capture`}
        className="tm-phone-dock__fab"
        aria-label={tOr('shell.mobile.capture', 'Quick capture')}
      >
        <span className="tm-mobile-nav__glyph" aria-hidden="true">
          +
        </span>
        <PhoneIcon name="plus" size={28} />
      </Link>
      {moreOpen ? (
        <MoreSheet
          id={sheetId}
          organizationSlug={organizationSlug}
          onClose={closeMore}
          {...(requestsCount !== undefined ? { requestsCount } : {})}
        />
      ) : null}
    </div>
  );
}
