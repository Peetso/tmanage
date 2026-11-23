'use client';

import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, InfoButton, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  aiActivityKey,
  listAiActivity,
  type AiActivityItem,
  type AiActivityVerb,
} from '../../lib/api/ai-panel';
import { countNoun } from '../../lib/i18n/plural';
import { useAiText } from '../ai-chat/use-ai-text';
import { CircleIcon, EyeIcon, PencilIcon } from '../ai-chat/icons';
import {
  ACTIVITY_REFRESH_MS,
  activityKind,
  dayLabelKind,
  groupByDay,
  isLive,
  type ActivityKind,
} from './ai-panel-model';
import { useAiPanelT, type AiPanelKey } from './use-ai-panel-t';

const VERB_ICON: Readonly<Record<AiActivityVerb, () => React.JSX.Element>> = {
  read: EyeIcon,
  changed: PencilIcon,
  waiting: CircleIcon,
};

const VERB_CAPSULE: Readonly<Record<AiActivityVerb, CapsuleState>> = {
  read: 'neutral',
  changed: 'done',
  waiting: 'waiting',
};

function kindKey(kind: ActivityKind, form: 'a' | 'one' | 'many' | 'label' | 'labels'): AiPanelKey {
  return `AiPanel.kind.${kind}.${form}` as AiPanelKey;
}

/**
 * The first line of a row: the item's name when the member can open it now, otherwise the kind
 * alone ("Read a task", "Read 4 tasks"; gap 1 ruling: no name the member cannot open).
 */
export function useActivityText() {
  const t = useAiPanelT();
  const text = useAiText();
  return {
    title(item: AiActivityItem): string {
      if (item.itemName) return item.itemName;
      const kind = activityKind(item.kind);
      const thing =
        item.count === null
          ? t(kindKey(kind, 'a'))
          : t('AiPanel.activity.count', {
              count: text.number(item.count),
              noun: countNoun(
                text.locale,
                item.count,
                t(kindKey(kind, 'one')),
                t(kindKey(kind, 'many')),
              ),
            });
      return t(`AiPanel.activity.${item.verb}` as AiPanelKey, { thing });
    },
    /** "Claude · Task · Website relaunch": app, kind, then the project when there is one. */
    source(item: AiActivityItem): string {
      const kind = activityKind(item.kind);
      const parts = [
        item.clientName,
        item.kind === null ? null : t(kindKey(kind, item.count === null ? 'label' : 'labels')),
        item.projectId !== null && item.kind !== 'project' ? item.projectName : null,
      ];
      return parts.filter((part): part is string => part !== null && part !== '').join(' · ');
    },
  };
}

export interface AiActivitySectionProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** Refresh every 20 s only while the tab is on screen (gap 1 ruling). */
  readonly active: boolean;
  readonly now?: () => Date;
}

/**
 * "Activity" (Figma 857:1014; states 858:906: nothing yet, no name, over days). Newest first, a
 * date line between days, an icon, the item, "App · kind · project", a Read / Changed / Waiting
 * capsule and the time. "Live" shows only while updates really arrive.
 */
export function AiActivitySection({
  api,
  organizationSlug,
  active,
  now = () => new Date(),
}: AiActivitySectionProps) {
  const t = useAiPanelT();
  const text = useAiText();
  const words = useActivityText();
  const activity = useInfiniteQuery({
    queryKey: aiActivityKey(organizationSlug),
    queryFn: ({ pageParam }) => listAiActivity(api, organizationSlug, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: active ? ACTIVITY_REFRESH_MS : false,
    retry: false,
  });
  // "Live" is re-judged as time passes, not only when a read lands. It measures the reads
  // themselves, so it uses the wall clock (`dataUpdatedAt` is wall-clock), not the display `now`.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), ACTIVITY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, activity.dataUpdatedAt]);
  const live = active && activity.isSuccess && isLive(activity.dataUpdatedAt, clock);

  const items = activity.data?.pages.flatMap((page) => page.items) ?? [];
  const today = now();
  const days = groupByDay(items);
  const multiDay = days.length > 1;

  return (
    <section className="tm-aip-section" aria-labelledby="tm-aip-activity">
      <div className="tm-aip-section__head">
        <h3 id="tm-aip-activity" className="tm-aip-section__title">
          {t('AiPanel.activity.title')}
        </h3>
        {live ? (
          <StateCapsule state="current" className="tm-aip-capsule">
            {t('AiPanel.activity.live')}
          </StateCapsule>
        ) : null}
        <InfoButton title={t('AiPanel.activity.title')} label={t('AiPanel.activity.infoLabel')}>
          {t('AiPanel.activity.info')}
        </InfoButton>
      </div>
      {activity.isPending ? (
        <ActivitySkeleton label={t('AiPanel.loading')} />
      ) : activity.isError ? (
        <div className="tm-aip-stack">
          <InlineAlert tone="danger" live>
            {t('AiPanel.activity.failed')}
          </InlineAlert>
          <div>
            <Button
              tone="outline"
              size="compact"
              className="tm-aip-touch"
              onClick={() => void activity.refetch()}
            >
              {t('AiPanel.tryAgain')}
            </Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="tm-aip-muted">{t('AiPanel.activity.empty')}</p>
      ) : (
        <>
          {days.map((day) => {
            const kind = dayLabelKind(day.key, today);
            const date = text.day(`${day.key}T12:00:00`);
            return (
              <div key={day.key} className="tm-aip-day">
                {multiDay || kind !== 'today' ? (
                  <p className="tm-aip-day__label">
                    {kind === 'today'
                      ? t('AiPanel.activity.today')
                      : kind === 'yesterday'
                        ? t('AiPanel.activity.yesterday', { date })
                        : date}
                  </p>
                ) : null}
                <ul className="tm-aip-rows">
                  {day.items.map((item) => {
                    const Icon = VERB_ICON[item.verb];
                    return (
                      <li key={item.id} className="tm-aip-row">
                        <span className="tm-aip-row__icon" aria-hidden="true">
                          <Icon />
                        </span>
                        <span className="tm-aip-row__text">
                          <span className="tm-aip-row__title">
                            <bdi>{words.title(item)}</bdi>
                          </span>
                          <span className="tm-aip-row__source">
                            <bdi>{words.source(item)}</bdi>
                          </span>
                        </span>
                        <span className="tm-aip-row__end">
                          <StateCapsule
                            state={item.failed ? 'blocked' : VERB_CAPSULE[item.verb]}
                            className="tm-aip-capsule"
                          >
                            {t(
                              item.failed
                                ? 'AiPanel.activity.notDone'
                                : (`AiPanel.activity.capsule.${item.verb}` as AiPanelKey),
                            )}
                          </StateCapsule>
                          <time className="tm-aip-row__time" dateTime={item.at}>
                            {text.time(item.at)}
                          </time>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {activity.hasNextPage ? (
            <button
              type="button"
              className="tm-aip-link"
              disabled={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
            >
              {t('AiPanel.activity.showMore')}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/** Loading: the rows' shape, quietly (Figma "Tab 2 loading"). */
export function ActivitySkeleton({ label }: { readonly label: string }) {
  return (
    <div className="tm-aip-skeleton" aria-busy="true">
      <p className="tm-aip-skeleton__label" role="status">
        <span className="tm-aip-spinner" aria-hidden="true" />
        {label}
      </p>
      {[0, 1, 2, 3].map((row) => (
        <span key={row} className="tm-aip-skeleton__row" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ))}
    </div>
  );
}
