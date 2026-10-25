'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import '../../styles/screens/home.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomePins } from '../../lib/api/home';
import type { HomePinTargetKind } from '../../lib/api/home';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
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
 * shows the target's kind; a work pin links to the item, the read fan-out that resolves a live title
 * being the deferred follow-up. The section is its own landmark (`aria-labelledby`) with a labelled
 * list, so it is axe-clean the way the sibling sections are.
 */
export function HomePinnedSection({ organizationSlug, client }: HomePinnedSectionProps) {
  const t = useT();
  const locale = useActiveLocale();
  const api = client ?? browserApiClient();

  const pins = useQuery({
    queryKey: ['home', 'pins', organizationSlug],
    queryFn: () => getHomePins(api, organizationSlug),
  });

  const items = pins.data?.pins ?? [];

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
          {items.map((item) => (
            <li key={item.id} className="tm-home-saved__item" data-kind={item.targetKind}>
              <span className="tm-home-orb" aria-hidden="true">
                {pinGlyph(item.targetKind)}
              </span>
              <span className="tm-home-saved__text">
                <span className="tm-home-saved__title">
                  {item.targetKind === 'work' ? (
                    <Link href={`/${organizationSlug}/work/${item.targetId}`}>
                      {t(pinTypeLabelKey(item.targetKind))}
                    </Link>
                  ) : item.targetKind === 'project' ? (
                    <Link href={`/${organizationSlug}/projects/${item.targetId}`}>
                      {t(pinTypeLabelKey(item.targetKind))}
                    </Link>
                  ) : (
                    <span>{t(pinTypeLabelKey(item.targetKind))}</span>
                  )}
                </span>
                <span className="tm-home-saved__meta">
                  {item.targetKind} · {t('HomePinnedSection.pinnedPrefix')}{' '}
                  {shortDay(item.createdAt, locale)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
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
  // Latin digits in Arabic, as the Arabic frames write them.
  const tag = locale.toLowerCase().startsWith('ar') ? 'ar-u-nu-latn' : 'en-GB';
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString(tag, { day: 'numeric', month: 'short' });
}

/** The message key each pinned reference shows. The live title/preview is the deferred read fan-out. */
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

function describePinsError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before your pinned items loaded.';
  return 'Something went wrong loading your pinned items.';
}
