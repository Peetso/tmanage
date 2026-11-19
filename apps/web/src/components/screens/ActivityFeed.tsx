'use client';

import Link from 'next/link';
import { useId, useMemo, type ReactNode } from 'react';
import { Avatar, Button, LoadingRegion, Skeleton } from '@tmanage/ui';
import { NavIcon } from '../icons/phone';
import { useDisplayFormatters, type DisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/activity.css';

/**
 * Every word the feed itself draws. The keys reach the catalogues through the wiring step
 * (B09-REPORT, WIRING); until then `tOr` returns the English given here, never a raw key.
 */
export const ACTIVITY_FEED_COPY = {
  'ActivityFeed.today': 'Today',
  'ActivityFeed.yesterday': 'Yesterday',
  'ActivityFeed.loading': 'Loading activity',
  'ActivityFeed.loadFailed': 'Could not load activity. Try again.',
  'ActivityFeed.tryAgain': 'Try again',
  'ActivityFeed.loadMore': 'Load more',
  'ActivityFeed.loadingMore': 'Loading…',
  'ActivityFeed.loadMoreFailed': 'Could not load more. Try again.',
  'ActivityFeed.showing': 'Showing {count}',
  'ActivityFeed.showingOf': 'Showing {count} of {total}',
  'ActivityFeed.showingOfAtLeast': 'Showing {count} of {total}+',
} as const;

type FeedCopyKey = keyof typeof ACTIVITY_FEED_COPY;

/** The person a row is about: drawn as an avatar; a client wears the violet ring. */
export interface ActivityFeedActor {
  readonly name: string;
  readonly client: boolean;
}

export interface ActivityFeedRow {
  /** Unique within the feed. */
  readonly id: string;
  /** ISO-8601 instant; the row sits under its day and shows its time. */
  readonly occurredAt: string;
  /** `null` for a system action: the system orb (Icon/settings) instead of a person (D3). */
  readonly actor: ActivityFeedActor | null;
  /** The whole sentence, the person's name included. Holds no link when `href` is set. */
  readonly sentence: ReactNode;
  /** Words after the time on the meta line ("10:42 · Cedar Foods brand refresh · Work"). */
  readonly meta?: readonly string[];
  /** The record the row names: the whole row is then one link to it (review FIGMA-D fix 2). */
  readonly href?: string;
  /** Drawn under the sentence of a row that is not a link (a comment's link preview). */
  readonly attachment?: ReactNode;
}

export type ActivityFeedState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly onRetry: () => void; readonly detail?: ReactNode }
  | { readonly status: 'ready'; readonly rows: readonly ActivityFeedRow[] };

/** Paging of an older-first tail: "Load more" while the source says there is more. */
export interface ActivityFeedMore {
  readonly hasMore: boolean;
  readonly busy: boolean;
  readonly failed: boolean;
  readonly onMore: () => void;
  /** D3: how many rows there are in all ("Showing 8 of 46"); `atLeast` draws "46+". */
  readonly total?: { readonly count: number; readonly atLeast: boolean };
}

export interface ActivityFeedProps {
  readonly title: string;
  readonly description?: string;
  readonly state: ActivityFeedState;
  /** What a ready feed with no row says (empty or "nothing matches", the caller decides). */
  readonly empty: ReactNode;
  /** "Today" and "Yesterday" are counted from here. */
  readonly now: Date;
  /** Paging and the "Showing N" line; a feed without it is complete in one read. */
  readonly more?: ActivityFeedMore;
}

interface DayGroup {
  readonly key: string;
  readonly label: string;
  readonly rows: readonly ActivityFeedRow[];
}

function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/** Rows (newest first) under their local day: "Today", "Yesterday", then "14 November". */
export function groupByDay(
  rows: readonly ActivityFeedRow[],
  now: Date,
  words: { readonly today: string; readonly yesterday: string },
  day: (iso: string) => string,
): readonly DayGroup[] {
  const today = dayKey(now);
  const before = new Date(now);
  before.setDate(before.getDate() - 1);
  const yesterday = dayKey(before);
  const groups: { key: string; label: string; rows: ActivityFeedRow[] }[] = [];
  for (const row of rows) {
    const at = new Date(row.occurredAt);
    const key = Number.isNaN(at.getTime()) ? row.occurredAt : dayKey(at);
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.rows.push(row);
      continue;
    }
    const label =
      key === today ? words.today : key === yesterday ? words.yesterday : day(row.occurredAt);
    groups.push({ key, label, rows: [row] });
  }
  return groups;
}

function dayLabel(display: DisplayFormatters, now: Date) {
  return (iso: string) =>
    new Date(iso).getFullYear() === now.getFullYear()
      ? display.day(iso, { day: 'numeric', month: 'long' })
      : display.day(iso, { day: 'numeric', month: 'long', year: 'numeric' });
}

function FeedRow({ row, time }: { readonly row: ActivityFeedRow; readonly time: string }) {
  const body = (
    <>
      {row.actor ? (
        <Avatar
          name={row.actor.name}
          audience={row.actor.client ? 'client' : 'internal'}
          decorative
          className="tm-act__avatar"
        />
      ) : (
        <span className="tm-act__system" aria-hidden="true">
          <NavIcon name="settings" size={16} />
        </span>
      )}
      <span className="tm-act__text">
        <span className="tm-act__sentence">{row.sentence}</span>
        <span className="tm-act__meta">
          <time dateTime={row.occurredAt}>{time}</time>
          {(row.meta ?? []).map((part) => (
            <span key={part}>
              {' · '}
              <bdi>{part}</bdi>
            </span>
          ))}
        </span>
        {row.href === undefined && row.attachment ? (
          <span className="tm-act__attachment">{row.attachment}</span>
        ) : null}
      </span>
    </>
  );
  return (
    <li className="tm-act__item">
      {row.href === undefined ? (
        <div className="tm-act__row">{body}</div>
      ) : (
        <Link className="tm-act__row tm-act__row--link" href={row.href}>
          {body}
        </Link>
      )}
    </li>
  );
}

/** "Showing 8 of 46" (D3), "Showing 8" when the source gives no total. */
function showing(
  count: number,
  total: ActivityFeedMore['total'],
  text: (key: FeedCopyKey) => string,
  display: DisplayFormatters,
): string {
  const key =
    total === undefined
      ? 'ActivityFeed.showing'
      : total.atLeast
        ? 'ActivityFeed.showingOfAtLeast'
        : 'ActivityFeed.showingOf';
  return text(key)
    .replace('{count}', display.number(count))
    .replace('{total}', display.number(Math.max(total?.count ?? 0, count)));
}

/**
 * **One activity feed** (FIGMA-D 753:41712 / 754:42228, review fixes 1–10) — every place that
 * shows "what happened here" draws it: a work item's timeline, a project's and a client's Activity
 * tab. It owns the card, the day groups, each row (avatar, sentence, meta line with the time), the
 * loading / failed / empty states and the "Load more" tail; it knows nothing about where rows come
 * from, so each screen maps its own read into rows and keeps its own filters.
 */
export function ActivityFeed({ title, description, state, empty, now, more }: ActivityFeedProps) {
  const headingId = useId();
  const tOr = useTOr();
  const display = useDisplayFormatters();
  const text = (key: FeedCopyKey) => tOr(key, ACTIVITY_FEED_COPY[key]);

  const groups = useMemo(
    () =>
      state.status === 'ready'
        ? groupByDay(
            state.rows,
            now,
            {
              today: tOr('ActivityFeed.today', ACTIVITY_FEED_COPY['ActivityFeed.today']),
              yesterday: tOr(
                'ActivityFeed.yesterday',
                ACTIVITY_FEED_COPY['ActivityFeed.yesterday'],
              ),
            },
            dayLabel(display, now),
          )
        : [],
    [state, now, tOr, display],
  );

  return (
    <section className="tm-act" aria-labelledby={headingId}>
      <div className="tm-act__head">
        <h2 id={headingId} className="tm-act__title">
          {title}
        </h2>
        {description ? <p className="tm-act__description">{description}</p> : null}
      </div>

      {state.status === 'loading' ? (
        <LoadingRegion label={text('ActivityFeed.loading')} className="tm-act__skeleton">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height="44px" />
          ))}
        </LoadingRegion>
      ) : null}

      {state.status === 'error' ? (
        <div className="tm-act__notice" role="alert">
          <p>{text('ActivityFeed.loadFailed')}</p>
          {state.detail ? <p className="tm-act__notice-detail">{state.detail}</p> : null}
          <Button tone="outline" size="accessible" onClick={state.onRetry}>
            {text('ActivityFeed.tryAgain')}
          </Button>
        </div>
      ) : null}

      {state.status === 'ready' && state.rows.length === 0 ? (
        <div className="tm-act__empty">{empty}</div>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="tm-act__day">
          <h3 id={`${headingId}-${group.key}`} className="tm-act__day-label">
            {group.label}
          </h3>
          <ol className="tm-act__list" aria-labelledby={`${headingId}-${group.key}`}>
            {group.rows.map((row) => (
              <FeedRow key={row.id} row={row} time={display.time(row.occurredAt)} />
            ))}
          </ol>
        </div>
      ))}

      {more && state.status === 'ready' && state.rows.length > 0 ? (
        <div className="tm-act__foot">
          <p className="tm-act__count">{showing(state.rows.length, more.total, text, display)}</p>
          {more.failed ? (
            <p className="tm-act__more-failed" role="alert">
              {text('ActivityFeed.loadMoreFailed')}
            </p>
          ) : null}
          {more.hasMore ? (
            <Button
              tone="outline"
              size="accessible"
              loading={more.busy}
              loadingLabel={text('ActivityFeed.loadingMore')}
              onClick={more.onMore}
            >
              {text('ActivityFeed.loadMore')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
