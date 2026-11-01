'use client';

import type { ReactElement } from 'react';
import { useParams } from 'next/navigation';
import type { PresenceView } from '../../../lib/api/presence';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { usePresence } from '../../../lib/use-presence';
import './status.css';

/**
 * Pure: the header line — "Online", "Last seen today 14:02", "… yesterday …", "… 3 Oct", or
 * nothing when the person hides it or was never seen. Arabic templates carry U+200F before the
 * time so the digits sit on the right side of the sentence.
 */
export function presenceText(
  view: PresenceView | undefined,
  t: (key: MessageKey) => string,
  locale: string,
  now: Date = new Date(),
): string | null {
  if (view === undefined) return null;
  if (view.online) return t('ChatStatus.online');
  if (view.lastSeenAt === null) return null;
  const seen = new Date(view.lastSeenAt);
  const time = seen.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(seen)) / 86_400_000);
  if (days === 0) return t('ChatStatus.lastSeenToday').replace('{time}', time);
  if (days === 1) return t('ChatStatus.lastSeenYesterday').replace('{time}', time);
  const date = seen.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  return t('ChatStatus.lastSeenOn').replace('{date}', date);
}

/** Online / last seen for one person, from the shared presence cache. */
export function PresenceLabel({ userId }: { readonly userId: string }): ReactElement | null {
  const t = useT();
  const locale = useActiveLocale();
  const params = useParams<{ orgSlug?: string }>();
  const organizationSlug = typeof params?.orgSlug === 'string' ? params.orgSlug : '';
  const view = usePresence(organizationSlug, userId);
  const text = presenceText(view, t, locale);
  if (text === null) return null;
  return (
    <span className="tm-presence" data-online={view?.online ? '' : undefined}>
      {text}
    </span>
  );
}
