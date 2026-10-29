'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { listActivitySupportSessions } from '../../../lib/api/platform-activity';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import type { MessageKey } from '../../../lib/i18n/t';
import { PlatformGate } from '../shared/platform-kit';

/**
 * The Activity & access frame (platform-admin v2 · PA-09, SPEC §5.5): the Platform admin gate and
 * the tab row every C1–C6 screen shares — Actions · Access · Platform admins · Support sessions
 * (open count) · Exports.
 */

export type ActivityTab = 'actions' | 'access' | 'platform' | 'support' | 'exports';

export const ACTIVITY_KEY = ['platform', 'activity'] as const;

/** 55-21: the Ease scoreboard is reached from the Activity tab row (Figma 444:21040). */
export type ActivityTabRowId = ActivityTab | 'ease';

const TABS: readonly {
  id: ActivityTabRowId;
  labelKey: MessageKey;
  english?: string;
  href: string;
}[] = [
  { id: 'actions', labelKey: 'PlatformActivity.tabActions', href: '/platform/activity' },
  { id: 'access', labelKey: 'PlatformActivity.tabAccess', href: '/platform/activity/access' },
  { id: 'platform', labelKey: 'PlatformActivity.tabPlatform', href: '/platform/activity/platform' },
  {
    id: 'support',
    labelKey: 'PlatformActivity.tabSupport',
    href: '/platform/activity/support-sessions',
  },
  { id: 'exports', labelKey: 'PlatformActivity.tabExports', href: '/platform/activity/exports' },
  {
    id: 'ease',
    labelKey: 'PlatformActivity.tabEase' as MessageKey,
    english: 'Ease scoreboard',
    href: '/platform/activity/ease-scoreboard',
  },
];

const TITLES: Record<ActivityTab, MessageKey> = {
  actions: 'PlatformActivity.actionsTitle',
  access: 'PlatformActivity.accessTitle',
  platform: 'PlatformActivity.platformTitle',
  support: 'PlatformActivity.supportTitle',
  exports: 'PlatformActivity.exportsTitle',
};

const DESCRIPTIONS: Record<ActivityTab, MessageKey> = {
  actions: 'PlatformActivity.actionsDescription',
  access: 'PlatformActivity.accessDescription',
  platform: 'PlatformActivity.platformDescription',
  support: 'PlatformActivity.supportDescription',
  exports: 'PlatformActivity.exportsDescription',
};

export function ActivityFrame({
  api,
  tab,
  actions,
  children,
}: {
  api: ApiClient;
  tab: ActivityTab;
  actions?: (me: PlatformMeView) => ReactNode;
  children: (me: PlatformMeView) => ReactNode;
}) {
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="activity"
      crumbs={[t('PlatformActivity.crumb'), t(TITLES[tab])]}
      title={t(TITLES[tab])}
      description={t(DESCRIPTIONS[tab])}
      {...(actions ? { actions } : {})}
    >
      {(me) => (
        <div className="tm-stack">
          <ActivityTabs api={api} tab={tab} />
          {children(me)}
        </div>
      )}
    </PlatformGate>
  );
}

export function ActivityTabs({ api, tab }: { api: ApiClient; tab: ActivityTabRowId }) {
  const t = useT();
  const tOr = useTOr();
  const open = useQuery({
    queryKey: [...ACTIVITY_KEY, 'support-sessions', 'open-count'],
    queryFn: () => listActivitySupportSessions(api, { state: 'open' }),
    staleTime: 30_000,
  });
  return (
    <nav className="tm-cc-card__actions" aria-label={t('PlatformActivity.tabsLabel')}>
      {TABS.map((item) => (
        <Link
          key={item.id}
          href={item.href}
          className={`tm-cc-pill${item.id === tab ? ' tm-cc-pill--on' : ''}`}
          {...(item.id === tab ? { 'aria-current': 'page' as const } : {})}
        >
          {item.english ? tOr(item.labelKey, item.english) : t(item.labelKey)}
          {item.id === 'support' && open.data && open.data.openCount > 0
            ? ` · ${String(open.data.openCount)}`
            : ''}
        </Link>
      ))}
    </nav>
  );
}

/** "12 Oct 2026, 14:05 UTC"-style moment, or a dash. */
export function moment(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Turn a filter object into a URL query string for "Export" and deep links. */
export function filterHref(path: string, filter: Readonly<Record<string, string | undefined>>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) params.set(key, value);
  }
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Saved filters: per-viewer convenience in browser storage, never required. */
export function readSavedFilters(storageKey: string): Record<string, Record<string, string>> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, Record<string, string>>)
      : {};
  } catch {
    return {};
  }
}

export function writeSavedFilters(
  storageKey: string,
  value: Record<string, Record<string, string>>,
): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage blocked: saved filters simply are not kept.
  }
}
