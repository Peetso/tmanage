'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { PhoneIcon } from '../icons/phone';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';

/**
 * The phone top bar's end (Figma 406:6382 "Actions"): a white bell orb that opens the
 * notifications and the avatar orb that opens the person's preferences.
 *
 * Below 768px the pair sits at the end of the organization line; from 768px the wrapper is
 * `display: contents` and the bell is hidden, so the avatar renders exactly as before.
 */
export function PhoneHeaderActions({
  organizationSlug,
  initials,
}: {
  organizationSlug: string;
  initials: ReactNode;
}) {
  const t = useT();
  const tOr = useTOr();
  return (
    <div className="tm-phone-actions">
      <Link
        href={`/${organizationSlug}/notifications`}
        className="tm-phone-bell"
        aria-label={tOr('shell.mobile.notifications', 'Notifications')}
      >
        <PhoneIcon name="bell" />
      </Link>
      <Link
        href={`/${organizationSlug}/preferences`}
        className="tm-phone-avatar"
        aria-label={t('shell.account.preferences')}
      >
        <span aria-hidden="true">{initials}</span>
      </Link>
    </div>
  );
}
