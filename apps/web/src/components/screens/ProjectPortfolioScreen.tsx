'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NewProjectLink } from '../projects/NewProjectLink';
import { ImportLink } from '../projects/ImportLink';
import { browserApiClient } from '../../lib/api/browser-client';
import { getPortfolioCapacity, listProjectPortfolio } from '../../lib/api/project-portfolio';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  buildTimeline,
  exceptionFirst,
  formatDay,
  formatWait,
  headline,
} from '../../lib/portfolio-presentation';
import type { PortfolioRow } from '../../lib/portfolio-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { PortfolioTimeline } from './portfolio/PortfolioTimeline';
import { PortfolioCapacityPanel } from './portfolio/PortfolioCapacityPanel';
import { ViewSwitcher } from '../views/ViewSwitcher';
import { useViewPreference } from '../views/use-view-preference';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/portfolio.css';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import '../../styles/screens/portfolio-planning.css';

type Translate = ReturnType<typeof useT>;
type TranslateOr = ReturnType<typeof useTOr>;

/** R38 G5-views: the Projects page's views. */
export const PROJECT_VIEWS = ['list', 'board', 'grid', 'timeline'] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

/**
 * Board columns in a fixed order. The API's project status is only active or archived, so an
 * active project is placed by the same exception-first reading the list uses: a decision is due
 * (danger), worth watching (warning), or on track.
 */
const STATUS_ORDER = ['at_risk', 'watch', 'on_track', 'archived'] as const;
export type BoardStatus = (typeof STATUS_ORDER)[number];

const TONE_STATUS: Record<PortfolioRow['tone'], BoardStatus> = {
  danger: 'at_risk',
  warning: 'watch',
  neutral: 'on_track',
};

/** The board's columns, in `STATUS_ORDER`; a column with no projects is left out. */
export function groupByStatus(
  rows: readonly PortfolioRow[],
): { status: BoardStatus; rows: PortfolioRow[] }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    rows: rows.filter((row) => (row.archived ? 'archived' : TONE_STATUS[row.tone]) === status),
  })).filter((group) => group.rows.length > 0);
}

const STATUS_ENGLISH: Record<BoardStatus, string> = {
  at_risk: 'Needs a decision',
  watch: 'Watch',
  on_track: 'On track',
  archived: 'Archived',
};

function statusLabel(status: BoardStatus, tOr: TranslateOr): string {
  return tOr(`ViewSwitcher.status.${status}`, STATUS_ENGLISH[status]);
}

export interface ProjectPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Project portfolio (x137) — POR-01 overview, POR-02 timeline, POR-03 capacity.**
 *
 * `38-MODULE-MAP` §Projects: a projects-owned roll-up across every project the reader can see. It
 * reads `GET …/projects/portfolio` and `GET …/projects/portfolio/capacity`, both gated on the server
 * by `work.read` and relation-scoped there.
 *
 * ## Exceptions first, dates not a score
 *
 * POR-01 puts the rows that need a decision at the top with a red or amber edge and a sentence
 * saying *why it is here* — a slipped forecast, a missed promise, a date with no float, a client who
 * has been waiting — then the COMMITTED / FORECAST / CLIENT WAIT columns. Every reason is arithmetic
 * on the row the API returns (`lib/portfolio-presentation.ts`); there is no RAG model or percentage.
 * Within each tone the server's order is kept.
 *
 * As everywhere, **authorization is the API's**: a refusal becomes a sentence, never a blank screen.
 */
export function ProjectPortfolioScreen({
  organizationSlug,
  organizationName,
  client,
}: ProjectPortfolioScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const [view, setView] = useViewPreference<ProjectView>(
    `projects:${organizationSlug}`,
    PROJECT_VIEWS,
    'list',
  );
  const viewLabels: Record<ProjectView, string> = {
    list: tOr('ViewSwitcher.list', 'List'),
    board: tOr('ViewSwitcher.board', 'Board'),
    grid: tOr('ViewSwitcher.grid', 'Grid'),
    timeline: tOr('ViewSwitcher.timeline', 'Timeline'),
  };

  const portfolio = useQuery({
    queryKey: ['project-portfolio', organizationSlug],
    queryFn: () => listProjectPortfolio(api, organizationSlug),
  });
  const capacity = useQuery({
    queryKey: ['project-portfolio-capacity', organizationSlug],
    queryFn: () => getPortfolioCapacity(api, organizationSlug),
  });

  const rows = useMemo(() => exceptionFirst(portfolio.data ?? []), [portfolio.data]);
  const timeline = useMemo(() => buildTimeline(portfolio.data ?? []), [portfolio.data]);
  const active = rows.filter((row) => !row.archived);
  const atRisk = active.filter((row) => row.tone !== 'neutral');
  const clientAtRisk = atRisk.filter((row) => Boolean(row.project.clientName)).length;
  const holding = active.filter(
    (row) => row.tone === 'neutral' && Boolean(row.project.committedOn),
  ).length;
  const hasRows = rows.length > 0;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={
        hasRows
          ? `${t('ProjectPortfolioScreen.portfolio')} · ${rows.length} ${rows.length === 1 ? t('ProjectPortfolioScreen.projectSingular') : t('ProjectPortfolioScreen.projectPlural')}`
          : t('ProjectPortfolioScreen.portfolio')
      }
      title={hasRows ? headline(atRisk.length) : t('ProjectPortfolioScreen.portfolio')}
      actions={
        <>
          <ImportLink organizationSlug={organizationSlug} {...(client ? { client } : {})} />
          <NewProjectLink organizationSlug={organizationSlug} {...(client ? { client } : {})} />
        </>
      }
      {...(hasRows
        ? {
            headerAside: (
              <div className="tm-por-metrics">
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{clientAtRisk}</span>
                    {clientAtRisk > 0 ? (
                      <span className="tm-por-metric__flag">
                        {t('ProjectPortfolioScreen.actNow')}
                      </span>
                    ) : null}
                  </div>
                  <div className="tm-por-metric__label">
                    {clientAtRisk === 1
                      ? t('ProjectPortfolioScreen.clientDateAtRisk')
                      : t('ProjectPortfolioScreen.clientDatesAtRisk')}
                  </div>
                </div>
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{holding}</span>
                  </div>
                  <div className="tm-por-metric__label">
                    {t('ProjectPortfolioScreen.holdingCommitment')}
                  </div>
                </div>
              </div>
            ),
          }
        : { description: t('ProjectPortfolioScreen.description') })}
    >
      {portfolio.isError ? (
        <InlineAlert tone="danger" title={t('ProjectPortfolioScreen.couldNotLoad')} live>
          {describeError(portfolio.error, t)}
        </InlineAlert>
      ) : null}

      {portfolio.isPending ? (
        <LoadingRegion label={t('ProjectPortfolioScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!portfolio.isPending && !portfolio.isError && rows.length === 0 ? (
        <TeachingEmptyState
          title={t('ProjectPortfolioScreen.noProjectsTitle')}
          explanation={tOr(
            'EmptyStates.projectsLine',
            'Projects hold your tasks, files and client updates in one place.',
          )}
          action={
            <NewProjectLink
              organizationSlug={organizationSlug}
              tone="lime"
              {...(client ? { client } : {})}
            />
          }
          helpSlug="start-a-project"
          helpLabel={tOr('EmptyStates.howProjectsWork', 'How projects work')}
        />
      ) : null}

      {hasRows ? (
        <div className="tm-view-bar tm-por-view-bar">
          <ViewSwitcher
            label={tOr('ViewSwitcher.projectsLabel', 'Projects view')}
            options={PROJECT_VIEWS.map((id) => ({ id, label: viewLabels[id] }))}
            value={view}
            onChange={setView}
          />
        </div>
      ) : null}

      {hasRows && view === 'list' ? (
        <section className="tm-por" aria-labelledby="tm-portfolio-heading">
          <h2 id="tm-portfolio-heading" className="tm-visually-hidden">
            {t('ProjectPortfolioScreen.projectsHeading')}
          </h2>
          <div className="tm-por__head" aria-hidden="true">
            <span>{t('ProjectPortfolioScreen.colProject')}</span>
            <span>{t('ProjectPortfolioScreen.colWhy')}</span>
            <span>{t('ProjectPortfolioScreen.colCommitted')}</span>
            <span>{t('ProjectPortfolioScreen.colForecast')}</span>
            <span className="tm-por__end">{t('ProjectPortfolioScreen.colClientWait')}</span>
          </div>
          <ul className="tm-por__list">
            {rows.map((row) => (
              <li key={row.project.projectId}>
                <PortfolioRowView organizationSlug={organizationSlug} row={row} t={t} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasRows && view === 'board' ? (
        <section className="tm-view-board" aria-label={viewLabels.board}>
          {groupByStatus(rows).map((group) => (
            <section
              key={group.status}
              className="tm-view-board__column"
              aria-labelledby={`tm-por-board-${group.status}`}
            >
              <h2 id={`tm-por-board-${group.status}`} className="tm-view-board__heading">
                {statusLabel(group.status, tOr)}
                <span className="tm-view-board__count">{group.rows.length}</span>
              </h2>
              {group.rows.map((row) => (
                <PortfolioCardView
                  key={row.project.projectId}
                  organizationSlug={organizationSlug}
                  row={row}
                  t={t}
                />
              ))}
            </section>
          ))}
        </section>
      ) : null}

      {hasRows && view === 'grid' ? (
        <ul className="tm-view-grid" aria-label={t('ProjectPortfolioScreen.projectsHeading')}>
          {rows.map((row) => (
            <li key={row.project.projectId}>
              <PortfolioCardView organizationSlug={organizationSlug} row={row} t={t} />
            </li>
          ))}
        </ul>
      ) : null}

      {hasRows && (view === 'list' || view === 'timeline') ? (
        <div className="tm-por-plan">
          <PortfolioTimeline timeline={timeline} />
          <PortfolioCapacityPanel
            organizationSlug={organizationSlug}
            capacity={capacity.data}
            pending={capacity.isPending}
            error={capacity.isError ? describeError(capacity.error, t) : null}
          />
        </div>
      ) : null}
      <CoachMarkTour
        organizationSlug={organizationSlug}
        tour="projects"
        {...(client ? { client } : {})}
      />
    </AppShell>
  );
}

function PortfolioRowView({
  organizationSlug,
  row,
  t,
}: {
  organizationSlug: string;
  row: PortfolioRow;
  t: Translate;
}) {
  const { project } = row;
  // An archived project's dates and waits are history, not commitments: the frame shows dashes.
  const committed = row.archived ? null : (project.committedOn ?? null);
  const forecast = row.archived ? null : (project.forecastOn ?? null);
  const waitHours = row.archived ? null : row.waitHours;
  const meta = row.archived
    ? t('ProjectPortfolioScreen.archivedMeta')
    : [project.clientName ?? t('ProjectPortfolioScreen.internal'), project.ownerName]
        .filter(Boolean)
        .join(' · ');
  const waitTone =
    waitHours === null
      ? 'muted'
      : waitHours >= 72
        ? 'danger'
        : waitHours >= 24
          ? 'warning'
          : undefined;

  return (
    <article
      className="tm-por-row"
      data-tone={row.tone}
      data-archived={row.archived ? 'true' : undefined}
      aria-labelledby={`tm-portfolio-${project.projectId}`}
    >
      <div className="tm-por-row__name">
        <h3 id={`tm-portfolio-${project.projectId}`} className="tm-por-row__title">
          <Link href={`/${organizationSlug}/projects/${project.projectId}`}>{project.name}</Link>
        </h3>
        <div className="tm-por-row__meta">{meta}</div>
      </div>

      <p className="tm-por-row__why">{row.why}</p>

      <dl
        className="tm-por-row__cell tm-por-row__cell--committed"
        data-tone={committed ? undefined : 'muted'}
      >
        <dt>{t('ProjectPortfolioScreen.colCommitted')}</dt>
        <dd>
          <bdi>{committed ? formatDay(committed) : '—'}</bdi>
        </dd>
      </dl>

      <dl
        className="tm-por-row__cell tm-por-row__cell--forecast"
        data-tone={forecast === null ? 'muted' : row.slipped ? 'danger' : undefined}
      >
        <dt>{t('ProjectPortfolioScreen.colForecast')}</dt>
        <dd>
          <bdi>{forecast ? formatDay(forecast) : '—'}</bdi>
        </dd>
      </dl>

      <dl className="tm-por-row__cell tm-por-row__cell--wait tm-por__end" data-tone={waitTone}>
        <dt>{t('ProjectPortfolioScreen.colClientWait')}</dt>
        <dd>{waitHours === null ? '—' : formatWait(waitHours)}</dd>
      </dl>
    </article>
  );
}

/** A project as a card — the board's and the grid's item. */
function PortfolioCardView({
  organizationSlug,
  row,
  t,
}: {
  organizationSlug: string;
  row: PortfolioRow;
  t: Translate;
}) {
  const { project } = row;
  const meta = row.archived
    ? t('ProjectPortfolioScreen.archivedMeta')
    : [project.clientName ?? t('ProjectPortfolioScreen.internal'), project.ownerName]
        .filter(Boolean)
        .join(' · ');
  const committed = row.archived ? null : (project.committedOn ?? null);
  return (
    <article
      className="tm-view-card"
      data-tone={row.tone === 'neutral' ? undefined : row.tone}
      aria-labelledby={`tm-por-card-${project.projectId}`}
    >
      <h3 id={`tm-por-card-${project.projectId}`} className="tm-view-card__title">
        <Link href={`/${organizationSlug}/projects/${project.projectId}`}>{project.name}</Link>
      </h3>
      <p className="tm-view-card__meta">{meta}</p>
      <p className="tm-view-card__meta">{row.why}</p>
      {committed ? (
        <p className="tm-view-card__meta">
          {t('ProjectPortfolioScreen.colCommitted')} <bdi>{formatDay(committed)}</bdi>
        </p>
      ) : null}
    </article>
  );
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectPortfolioScreen.apiError');
  return t('ProjectPortfolioScreen.genericError');
}
