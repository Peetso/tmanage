'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { WorkItemState } from '@tmanage/domain';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectPickerPopover, useA13T } from '../insights/ProjectPickerPopover';
import { InsightsPortfolioMobileSummary } from './InsightsPortfolioMobileSummary';
import {
  InsightsBars,
  InsightsCard,
  InsightsCardHead,
  InsightsMetric,
  InsightsMetrics,
  InsightsNote,
  InsightsSplit,
  InsightsTabs,
} from './InsightsKit';
import type { InsightsBar, InsightsTone } from './InsightsKit';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchInsightsPortfolio } from '../../lib/api/insights-portfolio';
import type { InsightsPortfolio, InsightsPortfolioProject } from '../../lib/api/insights-portfolio';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { useIsMobile } from '../../lib/hooks/useIsMobile';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { appLocale } from '../../lib/i18n/app-locale';

export interface InsightsPortfolioScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Header actions (INS-01's black "Export" capsule — the x135 workload CSV). */
  headerActions?: ReactNode;
  /** Optional page-level content rendered under the report. */
  children?: ReactNode;
}

/**
 * **Insights** — INS-01, the editorial exception report across the projects the caller can read.
 *
 * It reads `GET /v1/organizations/:orgSlug/insights/portfolio`, gated on the server by `work.read`.
 * Three decisions, all from the sibling insights screens:
 *
 * 1. **Authorization is the API's.** A caller without `work.read` gets the ordinary 403, which
 *    `describe()` turns into a sentence; the screen never guesses a capability of its own.
 * 2. **No invented numbers.** Every headline figure, row and bar is summed from the roll-up the API
 *    returned; a project the caller cannot read never appears, and an empty portfolio says so.
 * 3. **Exceptions, not averages.** Rows carry a risk edge (blocked work, approvals sent back) and
 *    there is no per-person figure anywhere — the frame's "no productivity scores" rule.
 */
export function InsightsPortfolioScreen({
  organizationSlug,
  organizationName,
  client,
  headerActions,
  children,
}: InsightsPortfolioScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const isMobile = useIsMobile();
  const t = useT();

  const pickerT = useA13T();
  // A13: the report's project selection lives in the URL (`?projects=a,b`), read once on mount.
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setSelected(readProjectsParam()), []);

  // Every readable project — the picker's options (and the report when nothing is selected).
  const everything = useQuery({
    queryKey: ['insights-portfolio', organizationSlug],
    queryFn: () => fetchInsightsPortfolio(api, organizationSlug),
  });
  const narrowed = useQuery({
    queryKey: ['insights-portfolio', organizationSlug, selected],
    queryFn: () => fetchInsightsPortfolio(api, organizationSlug, selected),
    enabled: selected.length > 0,
  });
  const portfolio = selected.length > 0 ? narrowed : everything;

  const apply = useCallback((projectIds: readonly string[]) => {
    setSelected(projectIds);
    writeProjectsParam(projectIds);
    setPickerOpen(false);
  }, []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const projectCount = portfolio.data?.projectCount;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="insights"
      eyebrow={t('InsightsPortfolioScreen.eyebrow')}
      title={t('InsightsPortfolioScreen.title')}
      actions={
        <>
          {projectCount !== undefined ? (
            <span className="tm-ins-picker-anchor">
              <button
                type="button"
                className="tm-ins-capsule"
                data-kind="trigger"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                title={pickerT('InsightsPicker.title')}
                onClick={() => setPickerOpen((open) => !open)}
              >
                {projectCount}{' '}
                {projectCount === 1
                  ? t('InsightsPortfolioScreen.nounProject')
                  : t('InsightsPortfolioScreen.nounProjects')}
              </button>
              {pickerOpen && everything.data ? (
                <ProjectPickerPopover
                  projects={everything.data.projects}
                  value={selected}
                  onApply={apply}
                  onClose={closePicker}
                />
              ) : null}
            </span>
          ) : null}
          {headerActions}
        </>
      }
    >
      <div className="tm-ins">
        <InsightsTabs
          organizationSlug={organizationSlug}
          current="overview"
          {...(portfolio.data?.projects[0]
            ? { projectId: portfolio.data.projects[0].projectId }
            : {})}
        />

        {portfolio.isPending ? (
          <LoadingRegion
            label={t('InsightsPortfolioScreen.loading')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="72px" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {portfolio.isError ? (
          <InlineAlert tone="danger" title={t('InsightsPortfolioScreen.loadErrorTitle')} live>
            {describe(portfolio.error)}
          </InlineAlert>
        ) : null}

        {portfolio.isSuccess ? (
          isMobile ? (
            <InsightsCard>
              <InsightsPortfolioMobileSummary
                portfolio={portfolio.data}
                organizationSlug={organizationSlug}
              />
            </InsightsCard>
          ) : (
            <PortfolioReport portfolio={portfolio.data} organizationSlug={organizationSlug} />
          )
        ) : null}

        {children}
      </div>
    </AppShell>
  );
}

function PortfolioReport({
  portfolio,
  organizationSlug,
}: {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}) {
  const t = useT();
  if (portfolio.projectCount === 0) {
    return (
      <InsightsCard>
        <p className="tm-ins-card__body">{t('InsightsPortfolioScreen.empty')}</p>
      </InsightsCard>
    );
  }

  const { projects } = portfolio;
  const items = sum(projects, (p) => p.deliveryFlow.itemCount);
  const blocked = sum(projects, (p) => p.deliveryFlow.counts.blocked);
  const approvals = sum(projects, (p) => p.approvalCycle.approvalCount);
  const changes = sum(projects, (p) => p.approvalCycle.metrics.changes_requested.count);
  const decided = sum(
    projects,
    (p) =>
      p.approvalCycle.metrics.approved.decidedCount +
      p.approvalCycle.metrics.changes_requested.decidedCount,
  );
  const decidedMs = sum(
    projects,
    (p) =>
      p.approvalCycle.metrics.approved.totalDurationMs +
      p.approvalCycle.metrics.changes_requested.totalDurationMs,
  );
  const mostBlocked = [...projects].sort(
    (a, b) => b.deliveryFlow.counts.blocked - a.deliveryFlow.counts.blocked,
  )[0];

  return (
    <>
      <InsightsMetrics label={t('InsightsPortfolioScreen.metricsLabel')}>
        <InsightsMetric
          value={decided === 0 ? '—' : formatHours(decidedMs / decided)}
          label={t('InsightsPortfolioScreen.metricMeanWaitLabel')}
          note={
            decided === 0
              ? t('InsightsPortfolioScreen.noApprovalDecided')
              : `${decided} ${
                  decided === 1
                    ? t('InsightsPortfolioScreen.approval')
                    : t('InsightsPortfolioScreen.approvals')
                } ${t('InsightsPortfolioScreen.decidedWord')}`
          }
        />
        <InsightsMetric
          value={blocked}
          badge={`${t('InsightsPortfolioScreen.ofWord')} ${items}`}
          badgeTone={blocked > 0 ? 'danger' : 'quiet'}
          label={t('InsightsPortfolioScreen.metricBlockedLabel')}
          note={
            blocked > 0 && mostBlocked
              ? `${mostBlocked.deliveryFlow.counts.blocked} ${t('InsightsPortfolioScreen.inWord')} ${mostBlocked.name}`
              : t('InsightsPortfolioScreen.nothingBlocked')
          }
        />
        <InsightsMetric
          value={changes}
          {...(approvals > 0
            ? {
                badge: `${t('InsightsPortfolioScreen.ofWord')} ${approvals}`,
                badgeTone: (changes > 0 ? 'warning' : 'lime') as InsightsTone,
              }
            : {})}
          label={t('InsightsPortfolioScreen.metricChangesLabel')}
          note={`${t('InsightsPortfolioScreen.across')} ${portfolio.projectCount} ${
            portfolio.projectCount === 1
              ? t('InsightsPortfolioScreen.nounProject')
              : t('InsightsPortfolioScreen.nounProjects')
          }`}
        />
      </InsightsMetrics>

      <InsightsSplit
        main={
          <>
            <div className="tm-ins-section-head">
              <h2 id="tm-portfolio-heading" className="tm-ins-section-head__title">
                {t('InsightsPortfolioScreen.exceptionsTitle')}
              </h2>
              <span className="tm-ins-section-head__aside">
                {t('InsightsPortfolioScreen.exceptionsAside')}
              </span>
            </div>
            <PortfolioTable portfolio={portfolio} organizationSlug={organizationSlug} />
          </>
        }
        side={
          <>
            <InsightsCard labelledBy="tm-portfolio-stages">
              <InsightsCardHead
                id="tm-portfolio-stages"
                title={t('InsightsPortfolioScreen.whereWorkSits')}
                units={t('InsightsPortfolioScreen.whereWorkSitsUnits')}
              />
              <StageBars projects={projects} />
            </InsightsCard>
            <InsightsNote eyebrow={t('InsightsPortfolioScreen.noteEyebrow')}>
              {t('InsightsPortfolioScreen.noteBody')}
            </InsightsNote>
          </>
        }
      />
    </>
  );
}

function PortfolioTable({
  portfolio,
  organizationSlug,
}: {
  portfolio: InsightsPortfolio;
  organizationSlug: string;
}) {
  const t = useT();
  return (
    <InsightsCard variant="table" label={t('InsightsPortfolioScreen.tableLabel')}>
      <table className="tm-ins-table">
        <caption className="tm-visually-hidden">
          {t('InsightsPortfolioScreen.tableCaption')}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t('InsightsPortfolioScreen.colProject')}</th>
            <th scope="col" className="tm-ins-table__num">
              {t('InsightsPortfolioScreen.colWorkItems')}
            </th>
            <th scope="col" className="tm-ins-table__num">
              {t('InsightsPortfolioScreen.colBlocked')}
            </th>
            <th scope="col" className="tm-ins-table__num">
              {t('InsightsPortfolioScreen.colChanges')}
            </th>
          </tr>
        </thead>
        <tbody>
          {portfolio.projects.map((project) => (
            <PortfolioRow
              key={project.projectId}
              project={project}
              organizationSlug={organizationSlug}
            />
          ))}
        </tbody>
      </table>
      <p className="tm-ins-card__foot">
        {t('InsightsPortfolioScreen.computed')} {formatMoment(portfolio.computedAt)}.
      </p>
    </InsightsCard>
  );
}

function PortfolioRow({
  project,
  organizationSlug,
}: {
  project: InsightsPortfolioProject;
  organizationSlug: string;
}) {
  const blocked = project.deliveryFlow.counts.blocked;
  const changes = project.approvalCycle.metrics.changes_requested.count;
  const tone: InsightsTone = blocked > 0 ? 'danger' : changes > 0 ? 'warning' : 'quiet';
  return (
    <tr data-tone={tone}>
      <th scope="row">
        <Link href={`/${organizationSlug}/insights/projects/${project.projectId}`}>
          {project.name}
        </Link>
      </th>
      <td className="tm-ins-table__num">{project.deliveryFlow.itemCount}</td>
      <td className="tm-ins-table__num" {...(blocked > 0 ? { 'data-tone': 'danger' } : {})}>
        {blocked}
      </td>
      <td className="tm-ins-table__num" {...(changes > 0 ? { 'data-tone': 'warning' } : {})}>
        {changes}
      </td>
    </tr>
  );
}

const STAGES: readonly { id: WorkItemState; labelKey: MessageKey }[] = [
  { id: 'backlog', labelKey: 'InsightsPortfolioScreen.stageBacklog' },
  { id: 'ready', labelKey: 'InsightsPortfolioScreen.stageReady' },
  { id: 'in_progress', labelKey: 'InsightsPortfolioScreen.stageInProgress' },
  { id: 'blocked', labelKey: 'InsightsPortfolioScreen.stageBlocked' },
  { id: 'internal_review', labelKey: 'InsightsPortfolioScreen.stageInternalReview' },
  { id: 'done', labelKey: 'InsightsPortfolioScreen.stageDone' },
];

/** INS-01's stage bars, summed across the roll-up. The open stage holding the most is lime. */
function StageBars({ projects }: { projects: readonly InsightsPortfolioProject[] }) {
  const t = useT();
  const totals = STAGES.map((stage) => ({
    ...stage,
    value: sum(projects, (p) => p.deliveryFlow.counts[stage.id]),
  }));
  const open = totals.filter((stage) => stage.id !== 'done');
  const heaviest = open.reduce<(typeof open)[number] | undefined>(
    (top, stage) => (stage.value > (top?.value ?? 0) ? stage : top),
    undefined,
  );
  const openTotal = sum(open, (stage) => stage.value);
  const bars: InsightsBar[] = totals.map((stage) => ({
    key: stage.id,
    label: t(stage.labelKey),
    value: stage.value,
    tone: stage.id === heaviest?.id ? 'lime' : 'ink',
    emphasis: stage.id === heaviest?.id,
  }));

  return (
    <>
      <InsightsBars bars={bars} label={t('InsightsPortfolioScreen.stageBarsLabel')} />
      <p className="tm-ins-card__body">
        {heaviest
          ? `${t(heaviest.labelKey)} ${t('InsightsPortfolioScreen.holdsMostOpen')} ${heaviest.value} ${t('InsightsPortfolioScreen.ofWord')} ${openTotal} ${t('InsightsPortfolioScreen.openItems')}`
          : t('InsightsPortfolioScreen.noOpenWork')}
      </p>
    </>
  );
}

/** The `?projects=` selection in the address bar, or none. */
function readProjectsParam(): string[] {
  if (typeof window === 'undefined') return [];
  const raw = new URLSearchParams(window.location.search).get('projects');
  if (!raw) return [];
  return [...new Set(raw.split(',').map((id) => id.trim()))].filter((id) => id !== '');
}

/** Put the selection back in the address bar without a navigation; empty removes the param. */
function writeProjectsParam(projectIds: readonly string[]): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (projectIds.length > 0) url.searchParams.set('projects', projectIds.join(','));
  else url.searchParams.delete('projects');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Add up one field across rows. */
function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

/** A mean duration as the frame writes it: whole hours under three days, days above. */
function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 72) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Format an ISO timestamp for display, following the browser's locale for the reason
 * `SessionsScreen` gives. An unparseable value is shown verbatim rather than as `Invalid Date`.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
