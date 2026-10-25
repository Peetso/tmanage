'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { getWorkTimeline } from '../../lib/api/work-views';
import type { WorkTimelineRow } from '../../lib/api/work-views';
import {
  formatInstant,
  isOverdue,
  stateCapsule,
  stateLabel,
} from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import '../../styles/screens/work-planning.css';

export interface WorkTimelineScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Pre-select a project (deep link `?project=`). Defaults to the first project the caller sees. */
  initialProjectId?: string;
  client?: ApiClient;
  /** Injected in tests so "today" and "past due" are measured against a fixed moment. */
  now?: Date;
}

const DAY = 86_400_000;
const MIN_WEEKS = 8;
const MAX_COLUMNS = 12;

/**
 * **WK-04 Timeline** — the Gantt from `TManage Screens - Work Extended.dc.html`, over the
 * timeline read (`GET .../work-views/timeline/:projectId`).
 *
 * Each row is one work item: its bar runs from its start to its due date (a single dated end
 * draws a short bar on that day). Solid ink is done, an ink outline is scheduled, an orange
 * outline is past due and not finished — with the overrun in days beside it — and a dashed
 * elbow leads in from each predecessor that ends before the bar begins. The read carries no
 * milestones and no baseline, so neither row is drawn.
 *
 * "Accessible list" swaps the chart for the same rows as a table — title, state, start, due and
 * what each depends on — the artboard's keyboard and list equivalent.
 */
export function WorkTimelineScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
  now: nowProp,
}: WorkTimelineScreenProps) {
  const describeError = useDescribeApiError();
  const t = useT();
  const api = client ?? browserApiClient();
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');
  const [listView, setListView] = useState(false);

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // A timeline is per project: with none chosen, the first project the caller can see.
  const chosenProjectId = projectId !== '' ? projectId : (projects.data?.[0]?.id ?? '');
  const projectName = projects.data?.find((project) => project.id === chosenProjectId)?.name;

  const timeline = useQuery({
    queryKey: ['work-timeline', organizationSlug, chosenProjectId],
    queryFn: () => getWorkTimeline(api, organizationSlug, chosenProjectId),
    enabled: chosenProjectId !== '',
  });

  const rows = useMemo(() => timeline.data?.items ?? [], [timeline.data]);

  const titlesById = useMemo(() => {
    const names = new Map<string, string>();
    for (const row of rows) names.set(row.id, row.title);
    return names;
  }, [rows]);

  const chart = useMemo(() => buildChart(rows, now), [rows, now]);
  const noProjects = projects.isSuccess && projects.data.length === 0;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={t('WorkTimelineScreen.title')}
      eyebrow={
        projectName
          ? `${projectName} · ${t('WorkTimelineScreen.timeline')}`
          : t('WorkTimelineScreen.timeline')
      }
      actions={
        <div className="wp-toolbar">
          <nav className="wp-segmented" aria-label={t('WorkTimelineScreen.workViews')}>
            <Link href={`/${organizationSlug}/work`}>{t('WorkTimelineScreen.list')}</Link>
            <span aria-current="page">{t('WorkTimelineScreen.timeline')}</span>
            <Link
              href={`/${organizationSlug}/work/calendar${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              {t('WorkTimelineScreen.calendar')}
            </Link>
            <Link
              href={`/${organizationSlug}/work/workload${
                chosenProjectId === '' ? '' : `?project=${encodeURIComponent(chosenProjectId)}`
              }`}
            >
              {t('WorkTimelineScreen.workload')}
            </Link>
          </nav>
          <label className="tm-visually-hidden" htmlFor="tm-timeline-project">
            {t('WorkTimelineScreen.showTimelineFor')}
          </label>
          <select
            id="tm-timeline-project"
            className="wp-select"
            value={chosenProjectId}
            disabled={projects.isPending || noProjects}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {chosenProjectId === '' ? (
              <option value="">{t('WorkTimelineScreen.chooseProject')}</option>
            ) : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="wp-capsule"
            aria-pressed={listView}
            onClick={() => setListView((current) => !current)}
          >
            {t('WorkTimelineScreen.accessibleList')}
          </button>
        </div>
      }
    >
      {projects.isError ? (
        <InlineAlert tone="danger" title={t('WorkTimelineScreen.projectsError')} live>
          {describeError(projects.error)}
        </InlineAlert>
      ) : null}

      {noProjects ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkTimelineScreen.noProjectTitle')}</h2>
          <p className="wp-empty__body">{t('WorkTimelineScreen.noProjectBody')}</p>
        </div>
      ) : null}

      {timeline.isError ? (
        <InlineAlert tone="danger" title={t('WorkTimelineScreen.timelineError')} live>
          {describeError(timeline.error)}
        </InlineAlert>
      ) : null}

      {chosenProjectId !== '' && timeline.isPending ? (
        <LoadingRegion label={t('WorkTimelineScreen.loading')}>
          <Skeleton height="38px" />
          <Skeleton height="40px" />
          <Skeleton height="40px" />
          <Skeleton height="40px" />
        </LoadingRegion>
      ) : null}

      {chosenProjectId !== '' && timeline.isSuccess && rows.length === 0 ? (
        <div className="wp-empty">
          <h2 className="wp-empty__title">{t('WorkTimelineScreen.emptyTitle')}</h2>
          <p className="wp-empty__body">{t('WorkTimelineScreen.emptyBody')}</p>
        </div>
      ) : null}

      {rows.length > 0 && !listView ? (
        <div className="wp-gantt">
          <div
            className="wp-gantt__scroll"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t('WorkTimelineScreen.chartRegion')}
          >
            <div className="wp-gantt__inner">
              <div className="wp-gantt__head" aria-hidden="true">
                <div className="wp-gantt__label wp-mono-label">
                  {t('WorkTimelineScreen.workLabel')}
                </div>
                <div className="wp-gantt__weeks">
                  {chart.columns.map((column) => (
                    <div
                      key={column.key}
                      className={`wp-gantt__week${column.current ? ' wp-gantt__week--now' : ''}`}
                    >
                      {column.label}
                    </div>
                  ))}
                </div>
              </div>
              {rows.map((row) => {
                const bar = chart.bars.get(row.id);
                const late = bar ? isOverdue(row, now) : false;
                return (
                  <div key={row.id} className="wp-gantt__row">
                    <div className="wp-gantt__label">
                      <Link
                        className="wp-gantt__title"
                        href={`/${organizationSlug}/work/${row.id}`}
                      >
                        {row.title}
                      </Link>
                    </div>
                    <div className="wp-gantt__lane">
                      {chart.today !== null ? (
                        <span
                          className="wp-gantt__today"
                          style={{ insetInlineStart: `${chart.today}%` }}
                          aria-hidden="true"
                        />
                      ) : null}
                      {row.predecessorIds.map((id) => {
                        const before = chart.bars.get(id);
                        if (!bar || !before || before.end >= bar.start) return null;
                        return (
                          <span
                            key={id}
                            className="wp-gantt__dep"
                            style={{
                              insetInlineStart: `${before.end}%`,
                              inlineSize: `${bar.start - before.end}%`,
                            }}
                            aria-hidden="true"
                          />
                        );
                      })}
                      {bar ? (
                        <>
                          <span
                            className={`wp-gantt__bar ${barClass(row, late)}`}
                            style={{
                              insetInlineStart: `${bar.start}%`,
                              inlineSize: `${Math.max(bar.end - bar.start, 1)}%`,
                            }}
                            title={`${stateLabel(row.state)} · ${formatInstant(row.startAt)} → ${formatInstant(row.dueAt)}`}
                          />
                          {late && row.dueAt !== null ? (
                            <span
                              className="wp-gantt__late"
                              style={{ insetInlineStart: `${bar.end}%` }}
                            >
                              +
                              {Math.max(
                                1,
                                Math.round((now.getTime() - Date.parse(row.dueAt)) / DAY),
                              )}
                              D
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span
                          className="wp-gantt__bar wp-gantt__bar--undated"
                          style={{ insetInlineStart: '0%', inlineSize: '12%' }}
                          title={t('WorkTimelineScreen.undated')}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="wp-gantt__foot">
            <span>{t('WorkTimelineScreen.legend')}</span>
            <span>{t('WorkTimelineScreen.legendList')}</span>
          </div>
        </div>
      ) : null}

      {rows.length > 0 && listView ? (
        <div
          className="wp-rows"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={t('WorkTimelineScreen.listRegion')}
        >
          <table>
            <caption className="tm-visually-hidden">
              {t('WorkTimelineScreen.captionPre')} {rows.length}{' '}
              {t('WorkTimelineScreen.captionShown')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('WorkTimelineScreen.colTitle')}</th>
                <th scope="col">{t('WorkTimelineScreen.colState')}</th>
                <th scope="col">{t('WorkTimelineScreen.colStart')}</th>
                <th scope="col">{t('WorkTimelineScreen.colDue')}</th>
                <th scope="col">{t('WorkTimelineScreen.colDependsOn')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <th scope="row">
                    <Link className="wp-row-title" href={`/${organizationSlug}/work/${item.id}`}>
                      {item.title}
                    </Link>
                  </th>
                  <td>
                    <StateCapsule state={stateCapsule(item.state)}>
                      {stateLabel(item.state)}
                    </StateCapsule>
                  </td>
                  <td>
                    <span className="wp-row-mono">{formatInstant(item.startAt)}</span>
                  </td>
                  <td>
                    <span
                      className={
                        isOverdue(item, now) ? 'wp-row-mono wp-row-mono--warn' : 'wp-row-mono'
                      }
                    >
                      {formatInstant(item.dueAt)}
                    </span>
                  </td>
                  <td>{dependsOnLabel(item, titlesById)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}

function barClass(row: WorkTimelineRow, late: boolean): string {
  if (row.state === 'done') return '';
  if (late) return 'wp-gantt__bar--late';
  return 'wp-gantt__bar--open';
}

interface Chart {
  readonly columns: readonly { key: string; label: string; current: boolean }[];
  /** Bar extents as percentages of the lane, keyed by work item id. */
  readonly bars: ReadonlyMap<string, { start: number; end: number }>;
  /** Where today falls, as a percentage, or `null` when it is outside the range. */
  readonly today: number | null;
}

/** Weekly columns (Monday first) spanning every dated row, and each row's bar within them. */
function buildChart(rows: readonly WorkTimelineRow[], now: Date): Chart {
  const spans = new Map<string, { from: number; to: number }>();
  for (const row of rows) {
    const start = row.startAt === null ? Number.NaN : Date.parse(row.startAt);
    const due = row.dueAt === null ? Number.NaN : Date.parse(row.dueAt);
    const from = Number.isNaN(start) ? due : start;
    const to = Number.isNaN(due) ? start : due;
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    spans.set(row.id, { from: Math.min(from, to), to: Math.max(from, to) });
  }

  const values = [...spans.values()];
  const earliest = values.length > 0 ? Math.min(...values.map((span) => span.from)) : now.getTime();
  const latest = values.length > 0 ? Math.max(...values.map((span) => span.to)) : now.getTime();

  const first = new Date(earliest);
  first.setUTCHours(0, 0, 0, 0);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const weeks = Math.max(MIN_WEEKS, Math.ceil((latest + DAY - first.getTime()) / (7 * DAY)));
  const step = Math.ceil(weeks / MAX_COLUMNS);
  const count = Math.ceil(weeks / step);
  const rangeStart = first.getTime();
  const rangeEnd = rangeStart + count * step * 7 * DAY;
  const total = rangeEnd - rangeStart;
  const percent = (time: number) => ((time - rangeStart) / total) * 100;

  const columns = Array.from({ length: count }, (_, index) => {
    const start = rangeStart + index * step * 7 * DAY;
    const date = new Date(start);
    return {
      key: String(start),
      label: date
        .toLocaleDateString('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' })
        .split(' ')
        .reverse()
        .join(' '),
      current: now.getTime() >= start && now.getTime() < start + step * 7 * DAY,
    };
  });

  const bars = new Map<string, { start: number; end: number }>();
  for (const [id, span] of spans) {
    bars.set(id, { start: percent(span.from), end: percent(span.to + DAY) });
  }

  const today =
    now.getTime() >= rangeStart && now.getTime() < rangeEnd ? percent(now.getTime()) : null;
  return { columns, bars, today };
}

function dependsOnLabel(row: WorkTimelineRow, titlesById: ReadonlyMap<string, string>): string {
  if (row.predecessorIds.length === 0) return '—';
  return row.predecessorIds.map((id) => titlesById.get(id) ?? id).join(', ');
}
