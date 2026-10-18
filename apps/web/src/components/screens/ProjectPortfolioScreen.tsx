'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NewProjectLink } from '../projects/NewProjectLink';
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
import { PortfolioTimeline } from './portfolio/PortfolioTimeline';
import { PortfolioCapacityPanel } from './portfolio/PortfolioCapacityPanel';
import '../../styles/screens/portfolio.css';
import '../../styles/screens/portfolio-planning.css';

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
          ? `Portfolio · ${rows.length} ${rows.length === 1 ? 'project' : 'projects'}`
          : 'Portfolio'
      }
      title={hasRows ? headline(atRisk.length) : 'Portfolio'}
      actions={
        <NewProjectLink organizationSlug={organizationSlug} {...(client ? { client } : {})} />
      }
      {...(hasRows
        ? {
            headerAside: (
              <div className="tm-por-metrics">
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{clientAtRisk}</span>
                    {clientAtRisk > 0 ? <span className="tm-por-metric__flag">act now</span> : null}
                  </div>
                  <div className="tm-por-metric__label">
                    {clientAtRisk === 1 ? 'client date at risk' : 'client dates at risk'}
                  </div>
                </div>
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{holding}</span>
                  </div>
                  <div className="tm-por-metric__label">holding their commitment</div>
                </div>
              </div>
            ),
          }
        : { description: 'Every project you can see, and where each one stands.' })}
    >
      {portfolio.isError ? (
        <InlineAlert tone="danger" title="Could not load the portfolio" live>
          {describeError(portfolio.error)}
        </InlineAlert>
      ) : null}

      {portfolio.isPending ? (
        <LoadingRegion label="Loading the portfolio.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!portfolio.isPending && !portfolio.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No projects yet">
          There are no projects you can see. When one is created and shared with you, it appears
          here.
        </InlineAlert>
      ) : null}

      {hasRows ? (
        <section className="tm-por" aria-labelledby="tm-portfolio-heading">
          <h2 id="tm-portfolio-heading" className="tm-visually-hidden">
            Projects
          </h2>
          <div className="tm-por__head" aria-hidden="true">
            <span>Project</span>
            <span>Why it is here</span>
            <span>Committed</span>
            <span>Forecast</span>
            <span className="tm-por__end">Client wait</span>
          </div>
          <ul className="tm-por__list">
            {rows.map((row) => (
              <li key={row.project.projectId}>
                <PortfolioRowView organizationSlug={organizationSlug} row={row} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasRows ? (
        <div className="tm-por-plan">
          <PortfolioTimeline timeline={timeline} />
          <PortfolioCapacityPanel
            organizationSlug={organizationSlug}
            capacity={capacity.data}
            pending={capacity.isPending}
            error={capacity.isError ? describeError(capacity.error) : null}
          />
        </div>
      ) : null}
    </AppShell>
  );
}

function PortfolioRowView({
  organizationSlug,
  row,
}: {
  organizationSlug: string;
  row: PortfolioRow;
}) {
  const { project } = row;
  // An archived project's dates and waits are history, not commitments: the frame shows dashes.
  const committed = row.archived ? null : (project.committedOn ?? null);
  const forecast = row.archived ? null : (project.forecastOn ?? null);
  const waitHours = row.archived ? null : row.waitHours;
  const meta = row.archived
    ? 'Archived · approvals preserved'
    : [project.clientName ?? 'Internal', project.ownerName].filter(Boolean).join(' · ');
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
        <dt>Committed</dt>
        <dd>
          <bdi>{committed ? formatDay(committed) : '—'}</bdi>
        </dd>
      </dl>

      <dl
        className="tm-por-row__cell tm-por-row__cell--forecast"
        data-tone={forecast === null ? 'muted' : row.slipped ? 'danger' : undefined}
      >
        <dt>Forecast</dt>
        <dd>
          <bdi>{forecast ? formatDay(forecast) : '—'}</bdi>
        </dd>
      </dl>

      <dl className="tm-por-row__cell tm-por-row__cell--wait tm-por__end" data-tone={waitTone}>
        <dt>Client wait</dt>
        <dd>{waitHours === null ? '—' : formatWait(waitHours)}</dd>
      </dl>
    </article>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
