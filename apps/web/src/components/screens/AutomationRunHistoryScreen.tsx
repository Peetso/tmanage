'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { AutomationSectionTabs } from './AutomationSectionTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflowTemplates,
  type WorkflowRunStatus,
} from '../../lib/api/automations';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { useHydrated } from '../../lib/use-hydrated';
import type { ApiClient } from '../../lib/api/client';
import { describeRunDetail } from './run-detail-view';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface AutomationRunHistoryScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The status filter options: "All" plus each allowlisted outcome the API accepts. */
const STATUS_OPTIONS = [{ value: 'all' }, { value: 'succeeded' }, { value: 'failed' }] as const;

type StatusFilter = (typeof STATUS_OPTIONS)[number]['value'];

/** Turn `notify_owner` into `Notify owner` for display. */
function humanize(kind: string): string {
  const spaced = kind.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in the viewer's own time zone. */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A short, locale-stable rendering of an ISO instant in the viewer's own time zone (2026-10-31 live
 * test: this page said 21:32 UTC while the rule page said 23:32 for the same run). AUT-04 names the
 * zone beside it, e.g. `15 AUG 09:12:04 AFRICA/CAIRO` — see {@link viewerZone}.
 */
function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The viewer's time zone as AUT-04 prints it (`AFRICA/CAIRO`); `UTC` when the browser has none. */
function viewerZone(): string {
  try {
    return (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').toUpperCase();
  } catch {
    return 'UTC';
  }
}

/**
 * **Automations & integrations (module 17, x164).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations & integrations ("run history"). This screen
 * reads the org-scoped, append-only record of every workflow run: a filterable list, newest first, and
 * a detail drawer that reads one run's `detail` on demand. Both routes are gated on the server by
 * `org.manage`, so a member without the capability sees the API's refusal rather than a blank page.
 *
 * ## What it does, and what it cannot
 *
 * - **Nothing runs here.** Runs are created by the execution path (x163); this screen only reads
 *   history. There is no re-run, edit or delete control — history is append-only.
 * - **The status filter offers only allowlisted values.** The `<select>` lists the exact set the API
 *   accepts, so a filter request is always a value the server will honour.
 */
export function AutomationRunHistoryScreen({
  organizationSlug,
  organizationName,
  client,
}: AutomationRunHistoryScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const zone = viewerZone();

  const statusLabel = (value: StatusFilter): string => {
    switch (value) {
      case 'succeeded':
        return t('AutomationRunHistoryScreen.filterSucceeded');
      case 'failed':
        return t('AutomationRunHistoryScreen.filterFailed');
      default:
        return t('AutomationRunHistoryScreen.filterAll');
    }
  };

  // The standing `useHydrated` barrier: the filter ships disabled in the server render, so a choice
  // made before hydration cannot change the DOM while the query keeps listing every status.
  const hydrated = useHydrated();
  const [status, setStatus] = useState<StatusFilter>('all');
  // `undefined` = nothing chosen yet, so the newest run is shown (AUT-04 opens on a run's
  // evidence); `null` = the person closed the panel.
  const [chosenRunId, setSelectedRunId] = useState<string | null | undefined>(undefined);

  const runs = useQuery({
    queryKey: ['workflow-runs', organizationSlug, status],
    queryFn: () =>
      listWorkflowRuns(
        api,
        organizationSlug,
        status === 'all' ? {} : { status: status as WorkflowRunStatus },
      ),
  });

  // Every run, read only while a filter is on, so a filter with no match can say what the list
  // does hold (2026-10-31 live-test fix: "Failed" showed "No runs yet" beside 4 succeeded runs).
  const allRuns = useQuery({
    queryKey: ['workflow-runs', organizationSlug, 'all'],
    queryFn: () => listWorkflowRuns(api, organizationSlug, {}),
    enabled: status !== 'all',
  });

  // The library, read only to put a template's name beside its id (AUT-04 "Rule · what it did").
  // A failure here is not shown: the run list stands on its own and falls back to the id.
  const templates = useQuery({
    queryKey: ['workflow-templates', organizationSlug],
    queryFn: async () => (await listWorkflowTemplates(api, organizationSlug)) ?? [],
  });
  const templateName = (id: string): string =>
    (Array.isArray(templates.data) ? templates.data : []).find((t) => t.id === id)?.name ?? id;

  const selectedRunId = chosenRunId === undefined ? (runs.data?.[0]?.id ?? null) : chosenRunId;

  const detail = useQuery({
    queryKey: ['workflow-run-detail', organizationSlug, selectedRunId],
    queryFn: () => getWorkflowRun(api, organizationSlug, selectedRunId as string),
    enabled: selectedRunId !== null,
  });

  const rows = runs.data ?? [];
  const succeeded = rows.filter((run) => run.status === 'succeeded').length;
  const failed = rows.filter((run) => run.status === 'failed').length;
  const loaded = !runs.isPending && !runs.isError;

  return (
    <SettingsShell
      section="automations"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      eyebrow={t('AutomationRunHistoryScreen.eyebrow')}
      title={
        loaded
          ? `${rows.length} ${rows.length === 1 ? t('AutomationRunHistoryScreen.titleRunsOne') : t('AutomationRunHistoryScreen.titleRunsMany')}`
          : t('AutomationRunHistoryScreen.titleFallback')
      }
      {...(loaded && rows.length > 0
        ? {
            titleMeta: `${succeeded} ${t('AutomationRunHistoryScreen.succeededLower')} · ${failed} ${t('AutomationRunHistoryScreen.failedLower')}`,
          }
        : {})}
    >
      <div className="tm-aut">
        <AutomationSectionTabs
          organizationSlug={organizationSlug}
          current="runs"
          end={
            <fieldset className="tm-aut-filters" disabled={!hydrated}>
              <legend className="tm-visually-hidden">
                {t('AutomationRunHistoryScreen.outcomeLegend')}
              </legend>
              {STATUS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="tm-aut-filter"
                  aria-pressed={status === option.value}
                  onClick={() => setStatus(option.value)}
                >
                  {statusLabel(option.value)}
                </button>
              ))}
            </fieldset>
          }
        />

        <div className="tm-aut-split">
          <section className="tm-aut-col" aria-labelledby="tm-run-list-heading">
            <h2 id="tm-run-list-heading" className="tm-visually-hidden">
              {t('AutomationRunHistoryScreen.runsHeading')}
            </h2>

            {runs.isError ? (
              <InlineAlert
                tone="danger"
                title={t('AutomationRunHistoryScreen.errorLoadHistoryTitle')}
                live
              >
                {describeError(t, runs.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-aut-tablecard">
              {runs.isPending ? (
                <div className="tm-aut-pad">
                  <LoadingRegion label={t('AutomationRunHistoryScreen.loadingHistory')}>
                    <Skeleton height="var(--row)" />
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                </div>
              ) : null}

              {loaded && rows.length === 0 && status !== 'all' ? (
                <div className="tm-aut-empty">
                  <p className="tm-aut-empty__title">
                    {status === 'failed'
                      ? tOr('AutomationRunHistoryScreen.noFailedTitle', 'No failed runs')
                      : tOr('AutomationRunHistoryScreen.noSucceededTitle', 'No succeeded runs')}
                  </p>
                  <p className="tm-aut-empty__body">
                    {describeNoMatch(tOr, status, allRuns.data?.length ?? 0)}
                  </p>
                  <Button
                    type="button"
                    tone="outline"
                    size="accessible"
                    className="tm-aut-empty__action"
                    onClick={() => setStatus('all')}
                  >
                    {tOr('AutomationRunHistoryScreen.showAllRuns', 'Show all runs')}
                  </Button>
                </div>
              ) : null}

              {loaded && rows.length === 0 && status === 'all' ? (
                <TeachingEmptyState
                  title={t('AutomationRunHistoryScreen.emptyTitle')}
                  explanation={t('teachEmpty.automationRunsBody')}
                />
              ) : null}

              {rows.length > 0 ? (
                <div
                  className="tm-aut-tablecard__scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow
                  // columns (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('AutomationRunHistoryScreen.tableLabel')}
                >
                  <table className="tm-aut-table tm-aut-table--compact">
                    <caption className="tm-visually-hidden">
                      {t('AutomationRunHistoryScreen.captionPrefix')} {rows.length}{' '}
                      {t('AutomationRunHistoryScreen.captionSuffix')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('AutomationRunHistoryScreen.colTime')}</th>
                        <th scope="col">{t('AutomationRunHistoryScreen.colTemplate')}</th>
                        <th scope="col">{t('AutomationRunHistoryScreen.colRunId')}</th>
                        <th scope="col" className="tm-aut-end">
                          {t('AutomationRunHistoryScreen.colOutcome')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((run) => {
                        const isFailed = run.status === 'failed';
                        const classes = [
                          run.id === selectedRunId ? 'is-selected' : '',
                          isFailed && run.id !== selectedRunId ? 'is-failed' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        return (
                          <tr key={run.id} className={classes || undefined}>
                            <td className="tm-aut-mono">{formatWhen(run.startedAt)}</td>
                            <th scope="row">
                              <span className="tm-aut-rowtitle">
                                {templateName(run.templateId)}
                              </span>
                              <span
                                className={`tm-aut-rowsub ${isFailed ? 'tm-aut-rowsub--danger' : ''}`}
                              >
                                {isFailed
                                  ? t('AutomationRunHistoryScreen.failedLower')
                                  : t('AutomationRunHistoryScreen.succeededLower')}{' '}
                                · {t('AutomationRunHistoryScreen.rowFinished')}{' '}
                                {formatWhen(run.finishedAt).toLowerCase()}
                              </span>
                            </th>
                            <td>
                              <button
                                type="button"
                                className="tm-aut-linkbtn tm-aut-mono"
                                aria-label={`${t('AutomationRunHistoryScreen.viewDetailsOfRun')} ${shortRunId(run.id)}`}
                                aria-pressed={run.id === selectedRunId}
                                onClick={() => setSelectedRunId(run.id)}
                              >
                                {shortRunId(run.id)}
                              </button>
                            </td>
                            <td className="tm-aut-end">
                              <span
                                className={`tm-aut-state ${isFailed ? 'tm-aut-state--danger' : 'tm-aut-state--live'}`}
                              >
                                {humanize(run.status)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          </section>

          <aside
            className="tm-aut-card tm-aut-evidence"
            aria-labelledby="tm-run-detail-heading"
            aria-live="polite"
          >
            <div className="tm-row tm-row--between">
              <h2 id="tm-run-detail-heading" className="tm-aut-eyebrow">
                {t('AutomationRunHistoryScreen.runDetailHeading')}
              </h2>
              {selectedRunId !== null ? (
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  onClick={() => setSelectedRunId(null)}
                >
                  {t('AutomationRunHistoryScreen.close')}
                </Button>
              ) : null}
            </div>

            {selectedRunId === null ? (
              <>
                <p className="tm-aut-card__title">
                  {t('AutomationRunHistoryScreen.chooseRunTitle')}
                </p>
                <p className="tm-aut-card__body">{t('AutomationRunHistoryScreen.chooseRunBody')}</p>
              </>
            ) : null}

            {selectedRunId !== null && detail.isError ? (
              <InlineAlert
                tone="danger"
                title={t('AutomationRunHistoryScreen.errorLoadRunTitle')}
                live
              >
                {describeError(t, detail.error)}
              </InlineAlert>
            ) : null}

            {selectedRunId !== null && detail.isPending ? (
              <LoadingRegion label={t('AutomationRunHistoryScreen.loadingRunDetail')}>
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {selectedRunId !== null && detail.data ? (
              <>
                <p className="tm-aut-mono">
                  {shortRunId(detail.data.id)} · {formatInstant(detail.data.startedAt)} {zone}
                </p>
                <p className="tm-aut-card__title">
                  {detail.data.status === 'succeeded'
                    ? t('AutomationRunHistoryScreen.ranAsExpected')
                    : t('AutomationRunHistoryScreen.stoppedBeforeActed')}
                </p>
                <ol className="tm-aut-steps">
                  <li>
                    <p className="tm-aut-steps__title">
                      {t('AutomationRunHistoryScreen.stepStarted')}
                    </p>
                    <p className="tm-aut-steps__body">
                      {templateName(detail.data.templateId)} ·{' '}
                      {formatInstant(detail.data.startedAt)} {zone}
                    </p>
                  </li>
                  <li className={detail.data.status === 'failed' ? 'is-danger' : undefined}>
                    <p className="tm-aut-steps__title">{humanize(detail.data.status)}</p>
                    <p className="tm-aut-steps__body">
                      {t('AutomationRunHistoryScreen.stepFinishedPrefix')}{' '}
                      {formatInstant(detail.data.finishedAt)} {zone}
                    </p>
                  </li>
                  <li>
                    <p className="tm-aut-steps__title">
                      {t('AutomationRunHistoryScreen.whatRecorded')}
                    </p>
                    <dl className="tm-aut-kv">
                      {describeRunDetail(detail.data.detail).map((line) => (
                        <div key={line.label} className="tm-aut-kv__row">
                          <dt>{line.label}</dt>
                          <dd>{line.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                </ol>
                <p className="tm-aut-card__foot">{t('AutomationRunHistoryScreen.foot')}</p>
              </>
            ) : null}
          </aside>
        </div>
      </div>
    </SettingsShell>
  );
}

/** AUT-04's short run reference: the last four characters of the id, e.g. `RUN·4C1E`. */
function shortRunId(id: string): string {
  return `RUN·${id
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-4)
    .toUpperCase()}`;
}

/**
 * AUT-04's mono time column: `TODAY 09:12`, `YEST 17:44`, or `13 AUG 16:00`, in the viewer's own
 * time zone, the same clock the rule page's "Last ran today at …" line uses.
 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = localDay(date);
  const today = localDay(new Date());
  const yesterday = localDay(new Date(Date.now() - 86_400_000));
  if (day === today) return `TODAY ${time}`;
  if (day === yesterday) return `YEST ${time}`;
  const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `${label.toUpperCase()} ${time}`;
}

/** The filtered empty state's line: what the unfiltered list holds, then how to see it. */
function describeNoMatch(
  tOr: (key: string, english: string) => string,
  status: StatusFilter,
  total: number,
): string {
  if (total === 0) {
    return tOr(
      'AutomationRunHistoryScreen.noMatchBody',
      'Nothing in this list matches. Choose All to see every run.',
    );
  }
  if (total === 1) {
    return status === 'failed'
      ? tOr(
          'AutomationRunHistoryScreen.noFailedBodyOne',
          'The one run in this list succeeded. Choose All to see it.',
        )
      : tOr(
          'AutomationRunHistoryScreen.noSucceededBodyOne',
          'The one run in this list failed. Choose All to see it.',
        );
  }
  return (
    status === 'failed'
      ? tOr(
          'AutomationRunHistoryScreen.noFailedBody',
          '{count} runs in this list succeeded and none failed. Choose All to see every run.',
        )
      : tOr(
          'AutomationRunHistoryScreen.noSucceededBody',
          '{count} runs in this list failed and none succeeded. Choose All to see every run.',
        )
  ).replace('{count}', String(total));
}

function describeError(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('AutomationRunHistoryScreen.errorApiUnreachable');
  return t('AutomationRunHistoryScreen.errorGeneric');
}
