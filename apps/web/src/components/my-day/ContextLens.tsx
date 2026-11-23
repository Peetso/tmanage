'use client';

import { useId } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { listWorkActivity } from '../../lib/api/work-activity';
import type { WorkItemAudience } from '../../lib/api/work-items';
import { PORTAL_PROJECT_PARAM } from '../shell/PortalProjectSwitcher';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import type { MessageKey } from '../../lib/i18n/t';
import type { MyDayEntry } from './my-day-model';
import { clock, shortDate } from './my-day-format';

const AUDIENCE_KEY: Readonly<Record<WorkItemAudience, MessageKey>> = {
  internal: 'MyDay.audience.internal',
  client_visible: 'MyDay.audience.clientVisible',
  client_action_required: 'MyDay.audience.clientAction',
};

/**
 * **The context lens** (old frame `351:1972`, node `351:2188`; spec MYDAY-V4 §4.1, §4.2 rule 2):
 * the dark panel docked at the top of the side column, beside "Do this next", telling the story of
 * one item: its project, its title and due day, the latest three updates on the work-story rail,
 * who can see it, and "View as client". "⇱" opens the item and "✕" closes the lens.
 *
 * Every line is the API's: the updates are the item's own activity read, and "who can see this" is
 * its audience word (the API has no viewer list, so no avatars are drawn: build report §8.4).
 */
export function ContextLens({
  api,
  slug,
  entry,
  projectName,
  picked,
  onClose,
}: {
  readonly api: ApiClient;
  readonly slug: string;
  readonly entry: MyDayEntry;
  readonly projectName: string;
  /** The person chose this item (a card or row), rather than the page opening on "Do this next". */
  readonly picked: boolean;
  readonly onClose: () => void;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const titleId = useId();
  const item = entry.workItem;
  const href = `/${slug}/work/${encodeURIComponent(item.id)}`;
  const activity = useQuery({
    queryKey: ['work-activity', slug, item.id],
    queryFn: () => listWorkActivity(api, slug, item.id),
    retry: false,
  });
  const latest = (activity.data ?? []).slice(0, 3);

  return (
    <section
      className="tm-home-lens"
      aria-labelledby={titleId}
      data-picked={picked || undefined}
      data-widget="lens"
    >
      <div className="tm-home-lens__head">
        <p className="tm-home-lens__eyebrow">{t('MyDay.taskStory')}</p>
        <Link href={href} className="tm-home-lens__orb" aria-label={t('MyDay.openTask')}>
          <span aria-hidden="true">⇱</span>
        </Link>
        <button
          type="button"
          className="tm-home-lens__orb"
          aria-label={t('MyDay.close')}
          onClick={onClose}
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      <p className="tm-home-lens__project">
        <bdi>{projectName}</bdi>
      </p>
      <h2 id={titleId} className="tm-home-lens__title">
        <bdi>{item.title}</bdi>
      </h2>
      {item.dueAt ? (
        <p className="tm-home-lens__due">
          {fill(t('MyDay.dueOn'), { day: shortDate(locale, item.dueAt, false) })}
        </p>
      ) : null}

      <h3 className="tm-home-lens__heading">{t('MyDay.latest')}</h3>
      {activity.isPending ? null : latest.length === 0 ? (
        <p className="tm-home-lens__line">{t('MyDay.noActivity')}</p>
      ) : (
        <ol className="tm-work-story tm-home-lens__story">
          {latest.map((event, index) => (
            <li key={event.id} data-state={index === 0 ? 'current' : undefined}>
              <span className="tm-work-story__when">
                <bdi dir="ltr">{clock(event.occurredAt)}</bdi>
              </span>
              <span className="tm-work-story__title">
                <bdi>{event.summary}</bdi>
              </span>
            </li>
          ))}
        </ol>
      )}

      <h3 className="tm-home-lens__heading">{t('MyDay.whoCanSee')}</h3>
      <p className="tm-home-lens__line">{t(AUDIENCE_KEY[item.audience])}</p>
      {item.audience !== 'internal' ? (
        <Link
          href={`/${slug}/portal?${PORTAL_PROJECT_PARAM}=${encodeURIComponent(item.projectId)}`}
          className="tm-home-lens__client"
        >
          {t('MyDay.viewAsClient')}
        </Link>
      ) : null}
    </section>
  );
}
