'use client';

import { useId } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { InfoButton, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { HomeWidgetId } from '../../lib/api/home-widget-prefs';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';

/** What a widget's body shows: its rows, the skeleton, the one error row, or the one empty row. */
export type WidgetState = 'ready' | 'loading' | 'error' | 'empty';

export interface MyDayWidgetProps {
  readonly id: HomeWidgetId;
  readonly title: string;
  /** The info text (spec §5): at most two sentences, behind the circled "i". */
  readonly info?: string;
  /** At most three quiet controls (spec rule 3): chips, tabs, "All (n)", "⋯". */
  readonly actions?: ReactNode;
  readonly state: WidgetState;
  /** The empty widget's one line, two or three words (spec rule 5). */
  readonly empty?: string;
  /** How many skeleton rows the loading state draws, matching the real rows. */
  readonly skeletonRows?: number;
  readonly skeletonHeight?: string;
  readonly onRetry?: () => void;
  /** Extra class for the widget's own layout (`tm-myday-w--next`). */
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * **One My Day widget** (spec §3, Figma card `810:…`): the header row (title, the circled "i",
 * then the widget's quiet controls at the end) and a body that loads and fails on its own (rule 8).
 * An empty widget is one row of two or three words, never a paragraph and never removed (rule 5).
 * The section is a landmark named by its title, so a screen reader lists every widget.
 */
export function MyDayWidget({
  id,
  title,
  info,
  actions,
  state,
  empty,
  skeletonRows = 3,
  skeletonHeight = '40px',
  onRetry,
  className,
  children,
}: MyDayWidgetProps) {
  const t = useT();
  const headingId = useId();
  return (
    <section
      className={`tm-myday-w${className ? ` ${className}` : ''}`}
      data-widget={id}
      aria-labelledby={headingId}
      // At a glance moves focus here when a tile opens this widget.
      tabIndex={-1}
    >
      <div className="tm-myday-w__head">
        <h2 id={headingId} className="tm-myday-w__title">
          {title}
        </h2>
        {info ? (
          <InfoButton title={title} label={fill(t('MyDay.about'), { title })}>
            {info}
          </InfoButton>
        ) : null}
        <span className="tm-myday-w__spacer" />
        {actions}
      </div>
      {state === 'loading' ? (
        <LoadingRegion label={t('MyDay.loading')}>
          <div className="tm-myday-w__skeleton">
            {Array.from({ length: skeletonRows }, (_, index) => (
              <Skeleton key={index} height={skeletonHeight} radius="var(--r-control)" />
            ))}
          </div>
        </LoadingRegion>
      ) : null}
      {state === 'error' ? (
        <div className="tm-myday-w__line" role="status">
          <span>{t('MyDay.loadFailed')}</span>
          {onRetry ? (
            <button type="button" className="tm-myday-link" onClick={onRetry}>
              {t('MyDay.tryAgain')}
            </button>
          ) : null}
        </div>
      ) : null}
      {state === 'empty' ? <div className="tm-myday-w__line">{empty}</div> : null}
      {state === 'ready' ? children : null}
    </section>
  );
}

/** "All (7)": the count link a list widget ends with, drawn only when there is something to open. */
export function AllLink({
  href,
  count,
  label,
}: {
  readonly href: string;
  readonly count: number;
  /** The list it opens, for the accessible name ("All (7): Due & at risk"). */
  readonly label: string;
}) {
  const t = useT();
  if (count <= 0) return null;
  const text = fill(t('MyDay.allCount'), { count });
  return (
    <Link href={href} className="tm-myday-link tm-myday-all" aria-label={`${text}: ${label}`}>
      {text}
    </Link>
  );
}

/**
 * "All (5)" where the list has no page of its own (Saved, Pinned): it opens the rest in place, so
 * the widget stays on My Day (spec rule 4), and says whether it is open.
 */
export function AllToggle({
  count,
  expanded,
  onToggle,
}: {
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="tm-myday-link tm-myday-all"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {fill(t('MyDay.allCount'), { count })}
    </button>
  );
}
