'use client';

import type { Timeline } from '../../../lib/portfolio-presentation';
import { useT } from '../../../lib/i18n/use-t';

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** The end chip flips to sit inside the bar once it would run off the window's edge. */
const FLIP_CHIP_AFTER = 78;

/**
 * **POR-02 · Portfolio timeline — "Cross-project commitments".** One bar per active project with a
 * commitment, from the day it started to its committed date (its forecast when it slipped). Black is
 * a held date, a red outline a slip, a dashed bar work that has not started, a lime dot a milestone
 * already met. The footer names the month that carries the most client-facing dates.
 */
export function PortfolioTimeline({ timeline }: { timeline: Timeline }) {
  const t = useT();
  return (
    <section className="tm-por-plan__panel" aria-labelledby="tm-por-timeline-heading">
      <header className="tm-por-plan__head">
        <div>
          <p className="tm-por-plan__eyebrow">{t('PortfolioTimeline.eyebrow')}</p>
          <h2 id="tm-por-timeline-heading" className="tm-por-plan__title">
            {t('PortfolioTimeline.heading')}
          </h2>
        </div>
        <p className="tm-por-tl__range">{timeline.range}</p>
      </header>

      <div className="tm-por-tl" data-testid="portfolio-timeline">
        <div className="tm-por-tl__grid tm-por-tl__months" aria-hidden="true">
          <span className="tm-por-tl__name">{t('PortfolioTimeline.projectColumn')}</span>
          {timeline.months.map((month) => (
            <span key={month} className="tm-por-tl__month">
              {MONTH.format(Date.parse(`${month}T00:00:00.000Z`))}
            </span>
          ))}
        </div>

        {timeline.rows.length === 0 ? (
          <p className="tm-por-tl__empty">{t('PortfolioTimeline.empty')}</p>
        ) : (
          <ul className="tm-por-tl__rows">
            {timeline.rows.map((row) => (
              <li key={row.projectId} className="tm-por-tl__grid tm-por-tl__row">
                <span className="tm-por-tl__name">{row.name}</span>
                <span className="tm-por-tl__track" data-variant={row.variant}>
                  <span
                    className="tm-por-tl__bar"
                    style={{ insetInlineStart: `${row.left}%`, inlineSize: `${row.width}%` }}
                    aria-hidden="true"
                  />
                  {row.metAt.map((at) => (
                    <span
                      key={at}
                      className="tm-por-tl__met"
                      style={{ insetInlineStart: `${at}%` }}
                      aria-hidden="true"
                    />
                  ))}
                  <span
                    className="tm-por-tl__chip"
                    style={
                      row.chipAt > FLIP_CHIP_AFTER
                        ? { insetInlineEnd: `${100 - row.chipAt}%` }
                        : { insetInlineStart: `${row.chipAt}%` }
                    }
                  >
                    {row.chipLabel ? (
                      <span className="tm-por-tl__chip-label">{row.chipLabel}</span>
                    ) : null}
                    {row.chipDate}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {timeline.summary ? <p className="tm-por-tl__foot">{timeline.summary}</p> : null}
      </div>
    </section>
  );
}
