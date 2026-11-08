'use client';

import { useContext, useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { NavIcon } from '../icons/phone';
import { MORE_TOOLS_NAVIGATION, MORE_WORKSPACE_NAVIGATION, type MoreSheetItem } from './navigation';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientRequestRecords } from '../../lib/api/client-requests';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface MoreSheetProps {
  id: string;
  organizationSlug: string;
  /** Close the sheet; the caller returns focus to the More button. */
  onClose: () => void;
  /** The Requests count; read live (new and in-triage requests) when omitted. */
  requestsCount?: number;
}

/** The number drawn on an orb. Nothing for zero: an empty badge reads as "something waits". */
export function OrbBadge({
  count,
  describedById,
  kind = 'unread',
}: {
  count: number;
  describedById: string;
  /** What the number counts: unread items (Inbox) or requests waiting (Requests). */
  kind?: 'unread' | 'waiting';
}) {
  const tOr = useTOr();
  if (count <= 0) return null;
  return (
    <>
      <span className="tm-orb-badge" aria-hidden="true">
        {count > 99 ? '99+' : count}
      </span>
      {/* `hidden` keeps the words out of the link's name; `aria-describedby` still reads them. */}
      <span id={describedById} hidden>
        {(kind === 'waiting'
          ? tOr('MoreSheet.waiting', '{count} waiting')
          : tOr('shell.mobile.unread', '{count} unread')
        ).replace('{count}', String(count))}
      </span>
    </>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function LiveRequestsBadge({
  organizationSlug,
  describedById,
}: {
  organizationSlug: string;
  describedById: string;
}) {
  const requests = useQuery({
    queryKey: ['shell', 'requests-waiting', organizationSlug],
    queryFn: () =>
      listClientRequestRecords(browserApiClient(), organizationSlug, {
        states: ['submitted', 'triage'],
      }),
    staleTime: 60_000,
  });
  return (
    <OrbBadge count={requests.data?.length ?? 0} describedById={describedById} kind="waiting" />
  );
}

/**
 * The phone "More" sheet (Figma ph-more, 378:18252 / 379:3679): a white bottom sheet over the
 * dimmed screen with its grabber, "More" and "Done", the WORKSPACE grid of eight tiles and the
 * TOOLS & ACCOUNT row of four.
 *
 * It is a modal dialog: focus moves into it, Tab and Shift+Tab stay inside it, Escape or a tap on
 * the scrim closes it, and every tile is a real link that closes the sheet as it navigates.
 */
export function MoreSheet({ id, organizationSlug, onClose, requestsCount }: MoreSheetProps) {
  const tOr = useTOr();
  const queryClient = useContext(QueryClientContext);
  const sheetRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const requestsBadgeId = useId();
  const base = `/${organizationSlug}`;

  useEffect(() => {
    doneRef.current?.focus();
  }, []);

  // Escape closes; Tab and Shift+Tab wrap inside the sheet (a modal dialog keeps focus in it).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const inside = sheetRef.current?.contains(document.activeElement) ?? false;
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const requestsBadge =
    requestsCount !== undefined ? (
      <OrbBadge count={requestsCount} describedById={requestsBadgeId} kind="waiting" />
    ) : queryClient ? (
      <LiveRequestsBadge organizationSlug={organizationSlug} describedById={requestsBadgeId} />
    ) : null;

  const tile = (item: MoreSheetItem) => {
    const isRequests = item.id === 'requests';
    return (
      <li key={item.id}>
        <Link
          href={item.absolute ? item.href : `${base}${item.href}`}
          className="tm-more__tile"
          onClick={onClose}
          {...(isRequests && requestsBadge ? { 'aria-describedby': requestsBadgeId } : {})}
        >
          <span className="tm-more__orb">
            <span aria-hidden="true">
              <NavIcon name={item.icon} />
            </span>
            {isRequests ? requestsBadge : null}
          </span>
          <span className="tm-more__label">{tOr(item.messageKey, item.label)}</span>
        </Link>
      </li>
    );
  };

  return (
    <div className="tm-more">
      <div className="tm-more__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={sheetRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-more__sheet"
      >
        <span className="tm-more__grabber" aria-hidden="true" />
        <div className="tm-more__head">
          <h2 id={titleId} className="tm-more__title">
            {tOr('MoreSheet.title', 'More')}
          </h2>
          <button ref={doneRef} type="button" className="tm-more__done" onClick={onClose}>
            {tOr('MoreSheet.done', 'Done')}
          </button>
        </div>
        <h3 className="tm-more__section">{tOr('MoreSheet.workspace', 'Workspace')}</h3>
        <ul className="tm-more__grid">{MORE_WORKSPACE_NAVIGATION.map(tile)}</ul>
        <h3 className="tm-more__section">{tOr('MoreSheet.tools', 'Tools & account')}</h3>
        <ul className="tm-more__grid">{MORE_TOOLS_NAVIGATION.map(tile)}</ul>
      </div>
    </div>
  );
}
