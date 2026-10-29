'use client';

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPublicAnnouncement } from '../../../lib/api/platform-settings';
import type {
  AnnouncementSeverity,
  PublicAnnouncementView,
} from '../../../lib/api/platform-settings';
import { translate } from '../../../lib/i18n/t';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';

/**
 * The platform announcement banner (PA-10, SPEC §4 D3) at the top of every workspace and client
 * portal, mounted by `ShellBanners` (PA-05). It reads `GET /public/site/announcements` for the
 * reader's language and organization (the `[orgSlug]` in the URL), shows the most severe live
 * banner, and remembers a dismissal per announcement in this browser only.
 */

const DISMISSED_KEY = 'tm.platformAnnouncement.dismissed';

function readDismissed(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Private mode or blocked storage: the banner simply comes back on the next visit.
  }
}

const TONES: Record<AnnouncementSeverity, CSSProperties> = {
  info: { background: 'var(--ink-900, #0b0b0b)', color: 'var(--paper-0, #fff)' },
  warning: { background: 'var(--warning-100, #fff4dc)', color: 'var(--ink-900, #0b0b0b)' },
  critical: { background: 'var(--danger-600, #c8322b)', color: 'var(--paper-0, #fff)' },
};

/** The banner itself, also used by the editor's "Preview in the app shell". */
export function AnnouncementBannerView({
  announcement,
  onDismiss,
}: {
  announcement: Pick<
    PublicAnnouncementView,
    'locale' | 'title' | 'body' | 'severity' | 'linkUrl' | 'dismissible'
  >;
  onDismiss?: () => void;
}) {
  const locale = announcement.locale;
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  return (
    <div
      role={announcement.severity === 'critical' ? 'alert' : 'status'}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      lang={locale}
      data-severity={announcement.severity}
      data-testid="platform-announcement"
      style={{
        ...TONES[announcement.severity],
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s3)',
        paddingBlock: 'var(--s2)',
        paddingInline: 'var(--s4)',
        fontSize: '0.875rem',
      }}
    >
      <span style={{ flex: 1, minInlineSize: 0 }}>
        <strong>{announcement.title}</strong>
        {announcement.body ? <> · {announcement.body}</> : null}
      </span>
      {announcement.linkUrl ? (
        <a href={announcement.linkUrl} style={{ color: 'inherit', textDecoration: 'underline' }}>
          {t('PlatformSettings.bannerDetails')}
        </a>
      ) : null}
      {announcement.dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('PlatformSettings.bannerDismiss')}
          style={{
            background: 'transparent',
            border: 0,
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/**
 * The organization slug and surface from the address (`/{orgSlug}/…`, `/{orgSlug}/portal/…`). Read
 * from `window.location` rather than the router so the banner mounts in any shell, test or story.
 */
export function locationOf(pathname: string): { slug: string | null; surface: 'app' | 'portal' } {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0] ?? null;
  const slug = first !== null && /^[a-z0-9][a-z0-9-]{0,79}$/u.test(first) ? first : null;
  return { slug, surface: segments[1] === 'portal' ? 'portal' : 'app' };
}

export function PlatformAnnouncementBanner({ client }: { client?: ApiClient } = {}) {
  const api = client ?? browserApiClient();
  const locale: 'en' | 'ar' = useActiveLocale().toLowerCase().startsWith('ar') ? 'ar' : 'en';
  const [where, setWhere] = useState<{
    slug: string | null;
    surface: 'app' | 'portal';
  } | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  useEffect(() => {
    setDismissed(readDismissed());
    setWhere(locationOf(window.location.pathname));
  }, []);
  const slug = where?.slug ?? null;
  const surface = where?.surface ?? 'app';

  const query = useQuery({
    queryKey: ['public', 'announcements', locale, surface, slug],
    queryFn: () => fetchPublicAnnouncement(api, { locale, surface, organizationSlug: slug }),
    enabled: where !== null,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const announcement = query.data?.announcement ?? null;
  if (!announcement || dismissed.includes(announcement.id)) return null;
  return (
    <AnnouncementBannerView
      announcement={announcement}
      onDismiss={() => {
        const next = [...dismissed, announcement.id];
        setDismissed(next);
        writeDismissed(next);
      }}
    />
  );
}
