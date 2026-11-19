'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { percent, shareOf } from '../../../lib/api/platform-growth';
import type { GrowthFigures as Figures } from '../../../lib/api/platform-growth';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { fillCopy, useGrowthCopy, type GrowthCopy } from './growth-copy';

/**
 * 62-A3 (B14) · Growth tiles (Figma 758:43241 EN / 758:43432 AR, review fixes 34–41): Activation,
 * AI and Money. Each tile names its own period and ignores the page's Month / Week switch.
 *
 * - A small meter never carries its value inside; the value is the caption under the bar, and the
 *   bar's `aria-valuetext` (fix 34).
 * - No AI data: no meter and no caption; the three AI tiles read the same (fix 36).
 * - Unit costs not set: "Not set" and an outline button to Platform settings, never 0 (fix 37).
 * - Margin: not available in the free beta (the page's not-available pattern).
 * - Below 720 px the tiles stack in one column (`tm-cc-metrics` is an auto-fit grid, fix 41).
 */

const UNIT_COSTS_HREF = '/platform/settings#unit-costs';

function Tile({
  id,
  label,
  value,
  muted = false,
  children,
}: {
  id: string;
  label: string;
  value: string;
  muted?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="tm-cc-metric tm-growth-tile">
      <p id={`tm-growth-${id}`} className="tm-cc-metric__source">
        {label}
      </p>
      <p className={muted ? 'tm-cc-metric__value tm-growth-tile__muted' : 'tm-cc-metric__value'}>
        {value}
      </p>
      {children}
    </li>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <p className="tm-growth-tile__sub">{children}</p>;
}

/** A 4 px meter; the value lives in the caption line under it (fix 34). */
function Meter({ fill, label, caption }: { fill: number; label: string; caption?: string }) {
  return (
    <>
      <span
        className="tm-cc-bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fill}
        aria-valuetext={caption ?? `${String(fill)} %`}
      >
        <span className="tm-cc-bar__fill" style={{ inlineSize: `${String(fill)}%` }} />
      </span>
      {caption === undefined ? null : <p className="tm-r44-sub">{caption}</p>}
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="tm-stack tm-stack--tight" aria-labelledby={`tm-growth-section-${id}`}>
      <h2 id={`tm-growth-section-${id}`} className="tm-cc-card__title">
        {title}
      </h2>
      <ul className="tm-cc-metrics">{children}</ul>
    </section>
  );
}

const thisWeekStart = (now: Date): string => {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
};

export function GrowthFigures({ figures, now = new Date() }: { figures: Figures; now?: Date }) {
  const copy = useGrowthCopy();
  const format = useDisplayFormatters();
  return (
    <>
      <ActivationTiles figures={figures} copy={copy} format={format} now={now} />
      <AiTiles figures={figures} copy={copy} format={format} />
      <MoneyTiles figures={figures} copy={copy} format={format} />
    </>
  );
}

type Format = ReturnType<typeof useDisplayFormatters>;
interface TileProps {
  figures: Figures;
  copy: GrowthCopy;
  format: Format;
}

function ActivationTiles({ figures, copy, format, now }: TileProps & { now: Date }) {
  const active = figures.weeklyActiveCompanies;
  const within30 = percent(figures.firstProjectFinished.within30d);
  const within60 = percent(figures.firstProjectFinished.within60d);
  const hours = figures.timeToFirstOutcomeP50Hours;
  return (
    <Section id="activation" title={copy('sectionActivation')}>
      <Tile
        id="weekly-active"
        label={copy('weeklyActive')}
        value={active === null ? copy('noData') : format.number(active.active)}
        muted={active === null}
      >
        {active === null ? null : (
          <>
            <Sub>
              {active.weekStart === thisWeekStart(now)
                ? copy('weeklyActiveSub')
                : fillCopy(copy('weeklyActiveSubWeekOf'), {
                    week: format.day(`${active.weekStart}T00:00:00Z`, {
                      day: 'numeric',
                      month: 'short',
                    }),
                  })}
            </Sub>
            <Meter
              fill={shareOf(active.active, active.companies)}
              label={copy('weeklyActive')}
              caption={fillCopy(copy('weeklyActiveOf'), {
                active: format.number(active.active),
                total: format.number(active.companies),
              })}
            />
          </>
        )}
      </Tile>
      <Tile
        id="first-project"
        label={copy('firstProjectFinished')}
        value={within30 === null ? copy('noData') : `${format.number(within30)} %`}
        muted={within30 === null}
      >
        {within30 === null ? null : (
          <>
            <Sub>{copy('firstProjectSub')}</Sub>
            <Meter fill={within30} label={copy('firstProjectSub')} />
            {within60 === null ? null : (
              <Meter
                fill={within60}
                label={copy('firstProjectFinished')}
                caption={fillCopy(copy('within60'), { percent: format.number(within60) })}
              />
            )}
          </>
        )}
      </Tile>
      <Tile
        id="first-outcome"
        label={copy('timeToOutcome')}
        value={
          hours === null
            ? copy('noData')
            : `${format.number(hours / 24, { maximumFractionDigits: 1 })} ${copy('days')}`
        }
        muted={hours === null}
      >
        {hours === null ? null : <Sub>{copy('timeToOutcomeSub')}</Sub>}
      </Tile>
    </Section>
  );
}

function AiTiles({ figures, copy, format }: TileProps) {
  const { ai } = figures;
  const tile = (id: string, label: string, value: number | null, extra?: ReactNode) => (
    <Tile
      id={id}
      label={label}
      value={value === null ? copy('noData') : format.number(value)}
      muted={value === null}
    >
      {value === null ? (
        <Sub>{copy('aiNoDataSub')}</Sub>
      ) : (
        (extra ?? <Sub>{copy('aiThisMonth')}</Sub>)
      )}
    </Tile>
  );
  const used = ai.creditsUsed;
  return (
    <Section id="ai" title={copy('sectionAi')}>
      {tile('ai-run', copy('aiTasksRun'), ai.tasksRun)}
      {tile('ai-finished', copy('aiTasksFinished'), ai.tasksCompleted)}
      {tile(
        'ai-credits',
        copy('aiCreditsUsed'),
        used,
        used === null ? undefined : (
          <Meter
            fill={shareOf(used, ai.creditsCap)}
            label={copy('aiCreditsUsed')}
            caption={fillCopy(copy('aiCreditsOf'), {
              used: format.number(used),
              cap: format.number(ai.creditsCap),
            })}
          />
        ),
      )}
    </Section>
  );
}

function MoneyTiles({ figures, copy, format }: TileProps) {
  const cost = figures.costPerActiveCompany;
  const { margin } = figures;
  const usd = (cents: number) => format.money(cents, 'USD');
  const setUnitCosts = (
    <Link className="tm-button tm-button--outline tm-button--compact" href={UNIT_COSTS_HREF}>
      {copy('setUnitCosts')}
    </Link>
  );
  return (
    <Section id="money" title={copy('sectionMoney')}>
      <Tile
        id="cost-per-company"
        label={copy('costPerCompany')}
        value={
          cost.available ? usd(cost.cents) : copy(cost.reason === 'not_set' ? 'notSet' : 'noData')
        }
        muted={!cost.available}
      >
        {cost.available ? (
          <Sub>{copy('costPerCompanySub')}</Sub>
        ) : cost.reason === 'not_set' ? (
          <>
            <Sub>{copy('notSetSub')}</Sub>
            <div>{setUnitCosts}</div>
          </>
        ) : (
          <Sub>{copy('noActiveCompanies')}</Sub>
        )}
      </Tile>
      <Tile
        id="margin"
        label={copy('margin')}
        value={
          margin.available
            ? `${format.number(Math.round(margin.rate * 100))} %`
            : margin.reason === 'beta_free'
              ? copy('marginBeta')
              : copy(margin.reason === 'not_set' ? 'notSet' : 'noData')
        }
        muted={!margin.available}
      >
        <Sub>
          {margin.available
            ? copy('marginSub')
            : margin.reason === 'beta_free'
              ? copy('marginBetaSub')
              : margin.reason === 'not_set'
                ? copy('marginNotSetSub')
                : copy('marginNoRevenue')}
        </Sub>
      </Tile>
    </Section>
  );
}
