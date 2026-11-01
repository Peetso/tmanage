'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createProjectBaseline,
  deleteProjectBaseline,
  getProjectBaselineVariance,
  listProjectBaselines,
} from '../../lib/api/project-baseline';
import type {
  ProjectBaselineSummary,
  ProjectBaselineVarianceRow,
} from '../../lib/api/project-baseline';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

type Translate = ReturnType<typeof useT>;

export interface ProjectBaselineViewProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose baselines this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

/**
 * **Project milestone-plan baseline (x295).**
 *
 * `22-SCREEN` PRJ timeline baseline; `38-MODULE-MAP` §Projects. This screen snapshots the current
 * milestone plan as a named baseline, lists the project's baselines (newest first), and reads a
 * variance view for a chosen baseline — a table of milestone, baseline date, current date, and the
 * slippage in days, recomputed by the API at read time. It reads
 * `GET …/projects/:id/baselines`, writes `POST …/baselines` and `DELETE …/baselines/:id`, and reads
 * `GET …/baselines/:id/variance`, all gated on the server by `project.manage`.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectBaselineView({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectBaselineViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [label, setLabel] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const baselines = useQuery({
    queryKey: ['project-baselines', organizationSlug, projectId],
    queryFn: () => listProjectBaselines(api, organizationSlug, projectId),
  });

  const variance = useQuery({
    queryKey: ['project-baseline-variance', organizationSlug, projectId, selectedId],
    queryFn: () => getProjectBaselineVariance(api, organizationSlug, projectId, selectedId ?? ''),
    enabled: selectedId !== null,
  });

  async function refetchList() {
    await queryClient.invalidateQueries({
      queryKey: ['project-baselines', organizationSlug, projectId],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createProjectBaseline(api, organizationSlug, projectId, { label: label.trim() }),
    onSuccess: async () => {
      setLabel('');
      await refetchList();
    },
  });

  const discard = useMutation({
    mutationFn: (baselineId: string) =>
      deleteProjectBaseline(api, organizationSlug, projectId, baselineId),
    onSuccess: async (_data, baselineId) => {
      if (selectedId === baselineId) setSelectedId(null);
      await refetchList();
    },
  });

  const rows = useMemo(() => baselines.data ?? [], [baselines.data]);
  const canSubmit = label.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || create.isPending) return;
    create.mutate();
  }

  const slip = variance.data
    ? variance.data.rows.reduce((most, row) => Math.max(most, row.deltaDays ?? 0), 0)
    : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('ProjectBaselineView.eyebrow')}
      title={t('ProjectBaselineView.title')}
      description={t('ProjectBaselineView.description')}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="plan" />
      }
      headerAside={
        slip !== null && variance.data ? (
          <div className="tm-prj-metrics">
            <div className="tm-metric">
              <div className="tm-metric__value-row">
                <span className="tm-metric__value">{slip}d</span>
                <span className={`tm-pill ${slip > 0 ? 'tm-pill--warning' : 'tm-pill--current'}`}>
                  {slip > 0 ? t('ProjectBaselineView.slip') : t('ProjectBaselineView.onTrack')}
                </span>
              </div>
              <span className="tm-metric__label">{t('ProjectBaselineView.largestMovement')}</span>
              <span className="tm-metric__source">{variance.data.label}</span>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="tm-prj tm-prj--plan">
        {baselines.isError ? (
          <InlineAlert tone="danger" title={t('ProjectBaselineView.couldNotLoadBaselines')} live>
            {describeError(baselines.error, t)}
          </InlineAlert>
        ) : null}

        {rows.length > 0 && discard.isError ? (
          <InlineAlert tone="danger" title={t('ProjectBaselineView.couldNotDiscard')} live>
            {describeError(discard.error, t)}
          </InlineAlert>
        ) : null}

        <div className="tm-prj__grid">
          <div className="tm-prj__col">
            {selectedId !== null ? (
              <section className="tm-prj-sheet" aria-labelledby="tm-variance-heading">
                <div className="tm-prj-sheet__head">
                  <h2 id="tm-variance-heading" className="tm-prj-eyebrow">
                    {t('ProjectBaselineView.variance')}
                  </h2>
                  {variance.data ? (
                    <span className="tm-meta-mono">{variance.data.label}</span>
                  ) : null}
                </div>

                {variance.isError ? (
                  <InlineAlert
                    tone="danger"
                    title={t('ProjectBaselineView.couldNotLoadVariance')}
                    live
                  >
                    {describeError(variance.error, t)}
                  </InlineAlert>
                ) : null}

                {variance.isPending ? (
                  <LoadingRegion label={t('ProjectBaselineView.computingVariance')}>
                    <Skeleton height="var(--row)" />
                  </LoadingRegion>
                ) : null}

                {!variance.isPending && !variance.isError && variance.data ? (
                  <div
                    className="tm-table-scroll"
                    // A scrollable region must be focusable or a keyboard cannot reach its overflow
                    // columns (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                    role="region"
                    aria-label={`${t('ProjectBaselineView.varianceForPrefix')} ${variance.data.label}`}
                  >
                    <table className="tm-table">
                      <caption className="tm-visually-hidden">
                        {t('ProjectBaselineView.captionLead')} “{variance.data.label}”,{' '}
                        {variance.data.rows.length} {t('ProjectBaselineView.captionTail')}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">{t('ProjectBaselineView.colMilestone')}</th>
                          <th scope="col">{t('ProjectBaselineView.colBaselineDate')}</th>
                          <th scope="col">{t('ProjectBaselineView.colCurrentDate')}</th>
                          <th scope="col">{t('ProjectBaselineView.colDelta')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {variance.data.rows.map((row) => (
                          <VarianceRow key={row.milestoneId} row={row} t={t} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                <p className="tm-prj-sheet__foot">{t('ProjectBaselineView.recomputedNote')}</p>
              </section>
            ) : (
              <section
                className="tm-card tm-card--empty tm-prj-card"
                aria-labelledby="tm-variance-empty"
              >
                <h2 id="tm-variance-empty" className="tm-prj-eyebrow">
                  {t('ProjectBaselineView.variance')}
                </h2>
                <p className="tm-card__meta">
                  {rows.length === 0
                    ? t('ProjectBaselineView.emptySnapshotFirst')
                    : t('ProjectBaselineView.emptyChoose')}
                </p>
              </section>
            )}
          </div>

          <div className="tm-prj__col">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-baselines-heading">
              <h2 id="tm-baselines-heading" className="tm-prj-eyebrow">
                {t('ProjectBaselineView.baselinesHeading')} · {rows.length}
              </h2>
              {baselines.isPending ? (
                <LoadingRegion label={t('ProjectBaselineView.loadingBaselines')}>
                  <Skeleton height="var(--row)" />
                  <Skeleton height="var(--row)" />
                </LoadingRegion>
              ) : null}
              {!baselines.isPending && !baselines.isError && rows.length === 0 ? (
                <InlineAlert tone="neutral" title={t('ProjectBaselineView.noBaselinesTitle')}>
                  {t('ProjectBaselineView.noBaselinesBody')}
                </InlineAlert>
              ) : null}
              {rows.length > 0 ? (
                <ul className="tm-prj-people">
                  {rows.map((baseline) => (
                    <BaselineRow
                      key={baseline.id}
                      baseline={baseline}
                      selected={selectedId === baseline.id}
                      busy={discard.isPending}
                      onView={() => setSelectedId(baseline.id)}
                      onDiscard={() => discard.mutate(baseline.id)}
                      t={t}
                    />
                  ))}
                </ul>
              ) : null}
            </section>

            <section className="tm-card tm-prj-card" aria-labelledby="tm-baseline-author">
              <h2 id="tm-baseline-author" className="tm-prj-eyebrow">
                {t('ProjectBaselineView.snapshotHeading')}
              </h2>
              <form className="tm-prj-form" onSubmit={onSubmit} noValidate>
                <fieldset
                  className="tm-fieldset tm-stack tm-stack--loose"
                  disabled={create.isPending}
                >
                  <Field
                    label={t('ProjectBaselineView.baselineNameLabel')}
                    name="label"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                    hint={t('ProjectBaselineView.baselineNameHint')}
                    required
                  />
                </fieldset>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('ProjectBaselineView.couldNotSnapshot')} live>
                    {describeError(create.error, t)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('ProjectBaselineView.saving')}
                    disabled={!canSubmit}
                  >
                    {t('ProjectBaselineView.snapshotNow')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function BaselineRow({
  baseline,
  selected,
  busy,
  onView,
  onDiscard,
  t,
}: {
  baseline: ProjectBaselineSummary;
  selected: boolean;
  busy: boolean;
  onView: () => void;
  onDiscard: () => void;
  t: Translate;
}) {
  return (
    <li>
      <div className="tm-prj-people__who">
        <span className="tm-prj-people__name">{baseline.label}</span>
        <span className="tm-prj-people__role">
          {baseline.milestoneCount}{' '}
          {baseline.milestoneCount === 1
            ? t('ProjectBaselineView.frozenSingular')
            : t('ProjectBaselineView.frozenPlural')}{' '}
          · {formatDate(baseline.createdAt)}
        </span>
      </div>
      <div className="tm-prj-people__end">
        <Button type="button" tone="ink" size="accessible" onClick={onView} disabled={selected}>
          {selected ? t('ProjectBaselineView.viewing') : t('ProjectBaselineView.viewVariance')}
        </Button>
        <Button
          type="button"
          tone="destructive"
          size="accessible"
          onClick={onDiscard}
          disabled={busy}
        >
          {t('ProjectBaselineView.discard')}
        </Button>
      </div>
    </li>
  );
}

function VarianceRow({ row, t }: { row: ProjectBaselineVarianceRow; t: Translate }) {
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {row.title ?? t('ProjectBaselineView.removedMilestone')}
      </th>
      <td>{row.baselineDate ?? '—'}</td>
      <td>{row.currentDate ?? '—'}</td>
      <td>{formatDelta(row.deltaDays, t)}</td>
    </tr>
  );
}

/** A signed day count: `+7` slipped later, `-3` pulled earlier, `On track` for zero, `—` unknown. */
function formatDelta(deltaDays: number | null, t: Translate): string {
  if (deltaDays === null) return '—';
  if (deltaDays === 0) return t('ProjectBaselineView.onTrackDelta');
  return deltaDays > 0 ? `+${deltaDays}` : String(deltaDays);
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString(appLocale());
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectBaselineView.apiError');
  return t('ProjectBaselineView.genericError');
}
