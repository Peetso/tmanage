import Link from 'next/link';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { PortfolioCapacity } from '../../../lib/api/project-portfolio';
import { NUMBER_WORDS, formatDay } from '../../../lib/portfolio-presentation';

export interface PortfolioCapacityPanelProps {
  organizationSlug: string;
  capacity: PortfolioCapacity | undefined;
  pending: boolean;
  error: string | null;
}

/**
 * **POR-03 · Portfolio capacity — "Where the team is the constraint".** Load by discipline for this
 * week (allocated hours over weekly capacity, from People), and the open commitments nobody owns in
 * the projects the reader can see. A discipline over 100 % is drawn as an amber outline, never a
 * longer bar: the overflow is the point, not a bigger number.
 */
export function PortfolioCapacityPanel({
  organizationSlug,
  capacity,
  pending,
  error,
}: PortfolioCapacityPanelProps) {
  return (
    <section className="tm-por-plan__panel" aria-labelledby="tm-por-capacity-heading">
      <header className="tm-por-plan__head">
        <div>
          <p className="tm-por-plan__eyebrow">Portfolio capacity</p>
          <h2 id="tm-por-capacity-heading" className="tm-por-plan__title">
            Where the team is the constraint
          </h2>
        </div>
      </header>

      {error ? (
        <InlineAlert tone="danger" title="Could not load capacity" live>
          {error}
        </InlineAlert>
      ) : null}

      {pending ? (
        <LoadingRegion label="Loading capacity.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {capacity ? (
        <>
          <div className="tm-por-cap" data-testid="portfolio-capacity">
            <p className="tm-por-cap__label">
              By discipline · week of {formatDay(capacity.weekStart)}
            </p>
            {capacity.disciplines.length === 0 ? (
              <p className="tm-por-cap__empty">
                No weekly capacity is recorded yet. Set hours and allocations on each person in{' '}
                <Link href={`/${organizationSlug}/people`}>People</Link>.
              </p>
            ) : (
              <ul className="tm-por-cap__list">
                {capacity.disciplines.map((row) => {
                  const over = row.loadPercent > 100;
                  const name = row.discipline ?? 'No discipline set';
                  return (
                    <li
                      key={name}
                      className="tm-por-cap__row"
                      data-over={over ? 'true' : undefined}
                    >
                      <span className="tm-por-cap__name">{name}</span>
                      <span
                        className="tm-por-cap__track"
                        role="meter"
                        aria-label={`${name} load`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(row.loadPercent, 100)}
                        aria-valuetext={`${row.loadPercent}% of ${row.capacityHours} hours`}
                      >
                        <span
                          className="tm-por-cap__fill"
                          style={{ inlineSize: `${Math.min(row.loadPercent, 100)}%` }}
                        />
                      </span>
                      <span className="tm-por-cap__value">{row.loadPercent}%</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div
            className="tm-por-unstaffed"
            data-alert={capacity.unstaffed.total > 0 ? 'true' : undefined}
          >
            <h3 className="tm-por-unstaffed__title">
              {capacity.unstaffed.total > 0 ? (
                <span className="tm-por-unstaffed__mark" aria-hidden="true">
                  !
                </span>
              ) : null}
              Unstaffed commitments · {capacity.unstaffed.total}
            </h3>
            {capacity.unstaffed.items.length > 0 ? (
              <ul className="tm-por-unstaffed__list">
                {capacity.unstaffed.items.map((item) => (
                  <li key={item.workItemId} className="tm-por-unstaffed__item">
                    <Link
                      className="tm-por-unstaffed__link"
                      href={`/${organizationSlug}/work/${item.workItemId}`}
                    >
                      {item.title}
                    </Link>
                    <span className="tm-por-unstaffed__meta">
                      {item.projectName.split(' ')[0]} ·{' '}
                      {item.dueOn ? formatDay(item.dueOn) : 'No date'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="tm-por-unstaffed__note">{capacitySentence(capacity)}</p>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** The closing sentence: which discipline is the constraint, and what the lever is. */
export function capacitySentence(capacity: PortfolioCapacity): string {
  const { constraint, unstaffed } = capacity;
  if (constraint) {
    const name = constraint.discipline ?? 'The team with no discipline set';
    const dates = constraint.internalDatesThisWeek;
    return dates > 0
      ? `${name} is the portfolio constraint. The lever is moving ${
          dates === 1
            ? 'one internal-only date'
            : `${(NUMBER_WORDS[dates] ?? String(dates)).toLowerCase()} internal-only dates`
        }, not asking one person for more hours.`
      : `${name} is the portfolio constraint at ${constraint.loadPercent}%. No internal-only date falls this week, so the lever is re-allocation, not more hours.`;
  }
  if (unstaffed.total > 0) return 'No discipline is over capacity this week; the gap is ownership.';
  return 'No discipline is over capacity this week, and every open commitment has an owner.';
}
