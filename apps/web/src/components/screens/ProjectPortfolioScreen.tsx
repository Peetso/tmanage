'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjectPortfolio } from '../../lib/api/project-portfolio';
import type { ProjectPortfolioSummary } from '../../lib/api/project-portfolio';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/portfolio.css';

export interface ProjectPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** Work that has not moved for this long is surfaced as an exception. */
const STALE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

const NUMBER_WORDS = [
  'No',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

type RowTone = 'danger' | 'warning' | 'neutral';

interface PortfolioRow {
  readonly project: ProjectPortfolioSummary;
  readonly tone: RowTone;
  readonly why: string;
  readonly archived: boolean;
}

/**
 * **Project portfolio (x137) — POR-01, exception-first rows.**
 *
 * `38-MODULE-MAP` §Projects: a projects-owned roll-up across every project the reader can see — one
 * row per project with its open-work count, its objective tallies (x124), and when work last moved.
 * It reads `GET …/projects/portfolio`, gated on the server by `work.read`.
 *
 * ## Exceptions first, counts not a score
 *
 * POR-01 puts the rows that need a decision at the top with a red or amber edge and a sentence
 * saying *why it is here*. The reasons are all arithmetic on the row the API returns — a missed
 * objective, or open work that has not moved for two weeks — never a grade: no RAG model, no
 * percentage. The commitment / forecast / client-wait columns of the frame need milestone data the
 * portfolio endpoint does not carry yet, so the row shows the counts it does have in their place.
 * Within each tone the server's order is kept.
 *
 * As everywhere, **authorization is the API's**: a caller without the capability gets the ordinary
 * refusal, which `describeError()` turns into a sentence; the screen never guesses a capability of its
 * own and never renders blank on a refusal.
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

  const rows = useMemo(() => exceptionFirst(portfolio.data ?? []), [portfolio.data]);
  const missedCount = rows.filter((row) => row.tone === 'danger').length;
  const openWork = rows.reduce((sum, row) => sum + row.project.openWorkCount, 0);
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
      title={hasRows ? headline(missedCount) : 'Portfolio'}
      {...(hasRows
        ? {
            headerAside: (
              <div className="tm-por-metrics">
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{missedCount}</span>
                    {missedCount > 0 ? <span className="tm-por-metric__flag">act now</span> : null}
                  </div>
                  <div className="tm-por-metric__label">
                    {missedCount === 1
                      ? 'project missed an objective'
                      : 'projects missed an objective'}
                  </div>
                </div>
                <div className="tm-por-metric">
                  <div className="tm-por-metric__figure">
                    <span className="tm-por-metric__value">{openWork}</span>
                  </div>
                  <div className="tm-por-metric__label">open work items</div>
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
            <span>Open work</span>
            <span>Objectives</span>
            <span className="tm-por__end">Last activity</span>
          </div>
          <ul className="tm-por__list">
            {rows.map((row) => (
              <li key={row.project.projectId}>
                <PortfolioRowView organizationSlug={organizationSlug} row={row} />
              </li>
            ))}
          </ul>
          <p className="tm-por__foot">
            These are counts, not a score. Every one of them is a number you can check on the
            project.
          </p>
        </section>
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
  const { open, met, missed } = project.objectiveCounts;
  const totalObjectives = open + met + missed;

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
        <div className="tm-por-row__meta">{row.archived ? project.status : 'Active'}</div>
      </div>

      <p className="tm-por-row__why">{row.why}</p>

      <dl className="tm-por-row__cell tm-por-row__cell--work">
        <dt>Open work</dt>
        <dd>{project.openWorkCount}</dd>
      </dl>

      <dl
        className={`tm-por-row__cell tm-por-row__cell--objectives${
          totalObjectives === 0 ? ' tm-por-row__cell--muted' : ''
        }`}
      >
        <dt>Objectives</dt>
        <dd>{totalObjectives === 0 ? 'None set' : `${open} open, ${met} met, ${missed} missed`}</dd>
      </dl>

      <dl
        className={`tm-por-row__cell tm-por-row__cell--activity tm-por__end${
          project.latestActivityAt === null ? ' tm-por-row__cell--muted' : ''
        }`}
      >
        <dt>Last activity</dt>
        <dd>
          {project.latestActivityAt === null ? (
            'No activity yet'
          ) : (
            <time
              dateTime={project.latestActivityAt}
              title={formatInstant(project.latestActivityAt)}
            >
              {formatShortDay(project.latestActivityAt)}
            </time>
          )}
        </dd>
      </dl>
    </article>
  );
}

/**
 * Tone and reason for each row, then a stable partition: missed objectives, then stalled work,
 * then the rest, then archived projects — each group in the server's order.
 */
function exceptionFirst(projects: readonly ProjectPortfolioSummary[]): PortfolioRow[] {
  const now = Date.now();
  const rows = projects.map((project): PortfolioRow => {
    const archived = project.status !== 'active';
    const { open, met, missed } = project.objectiveCounts;

    if (archived) return { project, tone: 'neutral', why: 'Archived', archived };

    if (missed > 0) {
      return {
        project,
        tone: 'danger',
        why: `${missed} ${missed === 1 ? 'objective' : 'objectives'} missed — needs a decision`,
        archived,
      };
    }

    const idleDays =
      project.latestActivityAt === null
        ? null
        : Math.floor((now - new Date(project.latestActivityAt).getTime()) / DAY_MS);
    if (project.openWorkCount > 0 && idleDays !== null && idleDays >= STALE_AFTER_DAYS) {
      return {
        project,
        tone: 'warning',
        why: `Open work, but nothing has moved in ${idleDays} days`,
        archived,
      };
    }

    if (open + met === 0) {
      return {
        project,
        tone: 'neutral',
        why:
          project.openWorkCount === 0
            ? 'No open work and no objective set'
            : 'No objective set yet',
        archived,
      };
    }
    return {
      project,
      tone: 'neutral',
      why: `${open} open · ${met} met — none missed`,
      archived,
    };
  });

  const rank = (row: PortfolioRow) =>
    row.archived ? 3 : row.tone === 'danger' ? 0 : row.tone === 'warning' ? 1 : 2;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

function headline(missedCount: number): string {
  if (missedCount === 0) return 'No project has missed an objective';
  const word = NUMBER_WORDS[missedCount] ?? String(missedCount);
  return missedCount === 1
    ? `${word} project missed an objective`
    : `${word} projects missed an objective`;
}

function formatShortDay(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(parsed);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
