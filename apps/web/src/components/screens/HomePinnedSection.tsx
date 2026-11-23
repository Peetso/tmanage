'use client';

import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import '../../styles/screens/home.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePins } from '../../lib/api/home';
import { getWorkItem } from '../../lib/api/work-items';
import { getProject } from '../../lib/api/projects';
import { getDocument } from '../../lib/api/documents';
import type { HomePinTargetKind } from '../../lib/api/home';
import { OFFLINE_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { appDateLocale } from '../../lib/i18n/app-locale';
import type { MessageKey } from '../../lib/i18n/t';

export interface HomePinnedSectionProps {
  organizationSlug: string;
  client?: ApiClient | undefined;
}

/**
 * **HOME-05 follow-up (x144)** — the Pinned section on the My Day screen, additive and disjoint from
 * the x143 hero and the older Saved (`saved_context`) section it sits beside.
 *
 * A faithful reader of the API's membership-scoped pins: it reads `GET .../home/pins` (behind
 * `work.read`, taking no membership id — the pins are the acting member's own) and lists each pin
 * newest first. A pin is a *reference* — its kind and id — not a copy of the target, so each row
 * reads its target's live name through the target's own authorized GET (as Recently viewed does,
 * and as the v3.1 Pinned widget did); a target the caller cannot read keeps the kind word. A work
 * pin links to the item, a project pin to the project. The section is its own landmark (`aria-labelledby`) with a labelled
 * list, so it is axe-clean the way the sibling sections are.
 */
export function HomePinnedSection({ organizationSlug, client }: HomePinnedSectionProps) {
  const describePinsError = useDescribeApiError(OFFLINE_LINES);
  const t = useT();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();

  const pins = useQuery({
    queryKey: ['home', 'pins', organizationSlug],
    queryFn: () => getHomePins(api, organizationSlug),
  });

  const items = pins.data?.pins ?? [];

  // My Day v4 visual check (2026-11-23): the restored section read "Pinned work item" on every
  // row, where the design and the v3.1 widget show the item's name. Shared query keys with the
  // item's own page; a long staleTime keeps the rail cheap.
  const titles = useQueries({
    queries: items.map((item) => ({
      queryKey: ['home', 'pin-title', organizationSlug, item.targetKind, item.targetId],
      queryFn: () => pinTitle(api, organizationSlug, item.targetKind, item.targetId),
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  });

  return (
    <section className="tm-home-saved" aria-labelledby="tm-my-day-pinned">
      <div className="tm-home-saved__head">
        <h2 id="tm-my-day-pinned" className="tm-home-saved__heading">
          {t('HomePinnedSection.heading')}
        </h2>
        {items.length > 0 ? <span className="tm-home-saved__count">{items.length}</span> : null}
      </div>

      {pins.isError ? (
        <InlineAlert tone="danger" title={t('HomePinnedSection.loadErrorTitle')} live>
          {describePinsError(pins.error)}
        </InlineAlert>
      ) : null}

      {pins.isPending ? (
        <LoadingRegion label={t('HomePinnedSection.loading')}>
          <Skeleton height="52px" radius="var(--r-control)" />
        </LoadingRegion>
      ) : null}

      {!pins.isPending && !pins.isError && items.length === 0 ? (
        <p className="tm-home-saved__empty">
          <strong>{t('HomePinnedSection.emptyTitle')}</strong>
          {t('HomePinnedSection.emptyBody')}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="tm-home-saved__list" aria-label={t('HomePinnedSection.listLabel')}>
          {items.map((item, index) => {
            const title = titles[index]?.data ?? t(pinTypeLabelKey(item.targetKind));
            return (
              <li key={item.id} className="tm-home-saved__item" data-kind={item.targetKind}>
                <span className="tm-home-orb" aria-hidden="true">
                  {pinGlyph(item.targetKind)}
                </span>
                <span className="tm-home-saved__text">
                  <span className="tm-home-saved__title">
                    {item.targetKind === 'work' ? (
                      <Link href={`/${organizationSlug}/work/${item.targetId}`}>{title}</Link>
                    ) : item.targetKind === 'project' ? (
                      <Link href={`/${organizationSlug}/projects/${item.targetId}`}>{title}</Link>
                    ) : (
                      <span>{title}</span>
                    )}
                  </span>
                  <span className="tm-home-saved__meta">
                    {t(pinKindKey(item.targetKind))} · {t('HomePinnedSection.pinnedPrefix')}{' '}
                    {shortDay(item.createdAt, locale)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

/** The target's live name through its own authorized read; null when it cannot be read. */
async function pinTitle(
  api: ApiClient,
  organizationSlug: string,
  targetKind: HomePinTargetKind,
  targetId: string,
): Promise<string | null> {
  try {
    switch (targetKind) {
      case 'work':
        return (await getWorkItem(api, organizationSlug, targetId)).title ?? null;
      case 'project':
        return (await getProject(api, organizationSlug, targetId)).name ?? null;
      case 'document':
        return (await getDocument(api, organizationSlug, targetId)).title ?? null;
    }
  } catch {
    return null;
  }
}

function pinGlyph(targetKind: HomePinTargetKind): string {
  switch (targetKind) {
    case 'work':
      return '▤';
    case 'project':
      return '◎';
    case 'document':
      return '◫';
  }
}

/** "13 Aug" — the design's short day in the saved-context meta line. */
function shortDay(value: string, locale: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(appDateLocale(locale), { day: 'numeric', month: 'short' });
}

/** The short kind word in the meta line ("Work", "عمل") — never the raw kind key. */
function pinKindKey(targetKind: HomePinTargetKind): MessageKey {
  switch (targetKind) {
    case 'work':
      return 'HomeRecentItemsView.kindWork';
    case 'project':
      return 'HomeRecentItemsView.kindProject';
    case 'document':
      return 'HomeRecentItemsView.kindDocument';
  }
}

/** The kind word a pinned reference shows while, or when, its live name cannot be read. */
function pinTypeLabelKey(targetKind: HomePinTargetKind): MessageKey {
  switch (targetKind) {
    case 'work':
      return 'HomePinnedSection.workLabel';
    case 'project':
      return 'HomePinnedSection.projectLabel';
    case 'document':
      return 'HomePinnedSection.documentLabel';
  }
}
