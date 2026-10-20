'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { browserApiClient } from '../../lib/api/browser-client';
import { getTeamCapacityHeatmap } from '../../lib/api/team-capacity-heatmap';
import type { CapacityHeatmapView } from '../../lib/api/team-capacity-heatmap';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/people.css';

export interface TeamCapacityHeatmapScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Overridable for tests; defaults to the current week's Monday. */
  defaultFrom?: string;
}

const DEFAULT_WEEKS = 8;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The Monday of the week containing `today`, as an ISO date `YYYY-MM-DD` (UTC). */
function currentMonday(today: Date): string {
  const utc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const day = new Date(utc).getUTCDay(); // 0 = Sunday
  const offset = (day + 6) % 7; // days since Monday
  return new Date(utc - offset * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The utilisation band a cell falls in — the colour scale, never colour alone. Each band pairs a
 * background token with a text label, so the grid reads for a colour-blind or screen-reader user too.
 */
interface Band {
  readonly id: string;
  /** The message key for the band's human label. */
  readonly labelKey: MessageKey;
  /** The legend swatch class; the cell paint is `data-band` in people.css, from the tokens. */
  readonly swatch: string;
}

const BANDS: readonly Band[] = [
  { id: 'none', labelKey: 'TeamCapacityHeatmapScreen.bandNone', swatch: 'ppl-swatch--none' },
  { id: 'under', labelKey: 'TeamCapacityHeatmapScreen.bandUnder', swatch: 'ppl-swatch--under' },
  { id: 'healthy', labelKey: 'TeamCapacityHeatmapScreen.bandHealthy', swatch: 'ppl-swatch--today' },
  { id: 'over', labelKey: 'TeamCapacityHeatmapScreen.bandOver', swatch: 'ppl-swatch--over' },
];

function bandFor(utilisation: number | null, overAllocated: boolean): Band {
  if (overAllocated) return BANDS[3]!;
  if (utilisation === null) return BANDS[0]!;
  if (utilisation < 0.7) return BANDS[1]!;
  return BANDS[2]!;
}

/**
 * **Team capacity heatmap (x193).**
 *
 * `38-MODULE-MAP` §People & capacity: the org-level view the per-person capacity/allocation screens
 * never gave — every member as a row, each week as a column, the cell coloured and labelled by
 * utilisation (allocated ÷ capacity). It reads `GET …/people/capacity/heatmap`, gated on the server by
 * `work.read`. Authorization is the API's: a caller without the capability gets the ordinary refusal,
 * which `describeError()` turns into a sentence; the screen never guesses a capability of its own.
 */
export function TeamCapacityHeatmapScreen({
  organizationSlug,
  organizationName,
  client,
  defaultFrom,
}: TeamCapacityHeatmapScreenProps) {
  const t = useT();
  const api = client ?? browserApiClient();
  const initialFrom = defaultFrom ?? currentMonday(new Date());

  const [from, setFrom] = useState(initialFrom);
  const [weeks, setWeeks] = useState(String(DEFAULT_WEEKS));
  const [applied, setApplied] = useState<{ from: string; weeks: number }>({
    from: initialFrom,
    weeks: DEFAULT_WEEKS,
  });

  const heatmap = useQuery({
    queryKey: ['team-capacity-heatmap', organizationSlug, applied.from, applied.weeks],
    queryFn: () => getTeamCapacityHeatmap(api, organizationSlug, applied),
  });

  const weeksValue = Number(weeks);
  const weeksValid = Number.isInteger(weeksValue) && weeksValue >= 1 && weeksValue <= 26;
  const fromValid = /^\d{4}-\d{2}-\d{2}$/.test(from);
  const canApply = fromValid && weeksValid;

  const view = heatmap.data;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      eyebrow={`${t('TeamCapacityHeatmapScreen.eyebrowPrefix')} ${applied.weeks} ${
        applied.weeks === 1
          ? t('TeamCapacityHeatmapScreen.weekSingular')
          : t('TeamCapacityHeatmapScreen.weekPlural')
      }`}
      title={t('TeamCapacityHeatmapScreen.title')}
      description={t('TeamCapacityHeatmapScreen.description')}
    >
      <div className="ppl-screen">
        <section className="ppl-card ppl-card--tight" aria-labelledby="tm-heatmap-window">
          <h2 id="tm-heatmap-window" className="ppl-mono">
            {t('TeamCapacityHeatmapScreen.windowHeading')}
          </h2>
          <form
            className="ppl-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canApply) return;
              setApplied({ from, weeks: weeksValue });
            }}
            noValidate
          >
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-heatmap-from">
                {t('TeamCapacityHeatmapScreen.firstWeekLabel')}
              </label>
              <input
                id="tm-heatmap-from"
                name="from"
                type="date"
                className="tm-field__control"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                required
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-heatmap-weeks">
                {t('TeamCapacityHeatmapScreen.weeksLabel')}
              </label>
              <input
                id="tm-heatmap-weeks"
                name="weeks"
                type="number"
                min={1}
                max={26}
                step={1}
                inputMode="numeric"
                className="tm-field__control"
                value={weeks}
                onChange={(event) => setWeeks(event.target.value)}
                aria-describedby="tm-heatmap-weeks-hint"
                required
              />
              <span className="tm-field__hint" id="tm-heatmap-weeks-hint">
                {t('TeamCapacityHeatmapScreen.weeksHint')}
              </span>
            </div>
            <Button type="submit" tone="ink" size="accessible" disabled={!canApply}>
              {t('TeamCapacityHeatmapScreen.apply')}
            </Button>
          </form>
        </section>

        <section aria-labelledby="tm-heatmap-legend-heading">
          <h2 id="tm-heatmap-legend-heading" className="tm-visually-hidden">
            {t('TeamCapacityHeatmapScreen.legendHeading')}
          </h2>
          <ul className="ppl-legend">
            {BANDS.map((band) => (
              <li key={band.id}>
                <span className={`ppl-swatch ${band.swatch}`} aria-hidden="true" />
                {t(band.labelKey)}
              </li>
            ))}
          </ul>
        </section>

        {heatmap.isError ? (
          <InlineAlert tone="danger" title={t('TeamCapacityHeatmapScreen.loadError')} live>
            {describeError(heatmap.error)}
          </InlineAlert>
        ) : null}

        {heatmap.isPending ? (
          <LoadingRegion label={t('TeamCapacityHeatmapScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {view !== undefined && view.members.length === 0 ? (
          <section
            className="ppl-card ppl-card--tight"
            aria-label={t('TeamCapacityHeatmapScreen.noMembersAria')}
          >
            <p className="ppl-dashed-note">{t('TeamCapacityHeatmapScreen.noMembersBody')}</p>
          </section>
        ) : null}

        {view !== undefined && view.members.length > 0 ? <HeatmapGrid view={view} /> : null}
      </div>
    </AppShell>
  );
}

function HeatmapGrid({ view }: { view: CapacityHeatmapView }) {
  const t = useT();
  const columns = useMemo(() => view.weekStarts, [view.weekStarts]);
  return (
    <section className="ppl-card ppl-card--tight" aria-labelledby="tm-heatmap-heading">
      <h2 id="tm-heatmap-heading" className="ppl-mono">
        {t('TeamCapacityHeatmapScreen.utilisationHeading')}
      </h2>
      <div
        className="tm-table-scroll"
        // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
        // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label={t('TeamCapacityHeatmapScreen.gridAria')}
      >
        <table className="ppl-heat">
          <caption className="tm-visually-hidden">
            {t('TeamCapacityHeatmapScreen.captionBefore')}
            {columns.length}
            {t('TeamCapacityHeatmapScreen.captionMid')}
            {view.from}
            {t('TeamCapacityHeatmapScreen.captionAfter')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('TeamCapacityHeatmapScreen.memberCol')}</th>
              {columns.map((weekStart) => (
                <th key={weekStart} scope="col">
                  {weekStart}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.members.map((member) => (
              <tr key={member.membershipId}>
                <th scope="row">{member.membershipId}</th>
                {member.cells.map((cell) => {
                  const band = bandFor(cell.utilisation, cell.overAllocated);
                  return (
                    <td key={cell.weekStart} data-band={band.id}>
                      {cell.capacityHours === 0 ? '—' : `${cell.allocatedPercent}%`}
                      <span className="tm-visually-hidden">
                        {` (${t(band.labelKey)}${
                          cell.utilisation === null
                            ? ''
                            : `, ${cell.allocatedHours}${t('TeamCapacityHeatmapScreen.hourSuffix')} ${t('TeamCapacityHeatmapScreen.ofWord')} ${cell.capacityHours}${t('TeamCapacityHeatmapScreen.hourSuffix')}`
                        })`}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
