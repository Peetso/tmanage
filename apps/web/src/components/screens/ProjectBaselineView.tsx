'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Milestone baselines"
      description="Snapshot the milestone plan, then compare today's dates against a saved baseline."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-baseline-author">
        <h2 id="tm-baseline-author" className="tm-eyebrow">
          Snapshot the plan
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
            <Field
              label="Baseline name"
              name="label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              hint="A name for this snapshot, e.g. “Kickoff plan” or “Q3 re-baseline”."
              required
            />
          </fieldset>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not snapshot the plan" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel="Saving"
              disabled={!canSubmit}
            >
              Snapshot now
            </Button>
          </div>
        </form>
      </section>

      {baselines.isError ? (
        <InlineAlert tone="danger" title="Could not load the baselines" live>
          {describeError(baselines.error)}
        </InlineAlert>
      ) : null}

      {baselines.isPending ? (
        <LoadingRegion label="Loading the project's baselines.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!baselines.isPending && !baselines.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No baselines yet">
          This project has no saved baselines. Snapshot the current plan above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && discard.isError ? (
        <InlineAlert tone="danger" title="Could not discard the baseline" live>
          {describeError(discard.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-baselines-heading">
          <h2 id="tm-baselines-heading" className="tm-eyebrow">
            Baselines
          </h2>
          <ul className="tm-stack">
            {rows.map((baseline) => (
              <BaselineRow
                key={baseline.id}
                baseline={baseline}
                selected={selectedId === baseline.id}
                busy={discard.isPending}
                onView={() => setSelectedId(baseline.id)}
                onDiscard={() => discard.mutate(baseline.id)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {selectedId !== null ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-variance-heading">
          <h2 id="tm-variance-heading" className="tm-eyebrow">
            Variance
          </h2>

          {variance.isError ? (
            <InlineAlert tone="danger" title="Could not load the variance view" live>
              {describeError(variance.error)}
            </InlineAlert>
          ) : null}

          {variance.isPending ? (
            <LoadingRegion label="Computing the variance against the baseline.">
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!variance.isPending && !variance.isError && variance.data ? (
            <div
              className="tm-table-scroll"
              // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
              // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              tabIndex={0}
              role="region"
              aria-label={`Variance for ${variance.data.label}`}
            >
              <table className="tm-table">
                <caption className="tm-visually-hidden">
                  Milestone dates today against the baseline “{variance.data.label}”,{' '}
                  {variance.data.rows.length} shown.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Milestone</th>
                    <th scope="col">Baseline date</th>
                    <th scope="col">Current date</th>
                    <th scope="col">Delta (days)</th>
                  </tr>
                </thead>
                <tbody>
                  {variance.data.rows.map((row) => (
                    <VarianceRow key={row.milestoneId} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </AppShell>
  );
}

function BaselineRow({
  baseline,
  selected,
  busy,
  onView,
  onDiscard,
}: {
  baseline: ProjectBaselineSummary;
  selected: boolean;
  busy: boolean;
  onView: () => void;
  onDiscard: () => void;
}) {
  return (
    <li className="tm-row tm-row--between">
      <div className="tm-stack tm-stack--tight">
        <span className="tm-table__title">{baseline.label}</span>
        <span className="tm-field__hint">
          {baseline.milestoneCount} milestone{baseline.milestoneCount === 1 ? '' : 's'} frozen ·{' '}
          {formatDate(baseline.createdAt)}
        </span>
      </div>
      <div className="tm-row">
        <Button type="button" tone="ink" size="accessible" onClick={onView} disabled={selected}>
          {selected ? 'Viewing' : 'View variance'}
        </Button>
        <Button
          type="button"
          tone="destructive"
          size="accessible"
          onClick={onDiscard}
          disabled={busy}
        >
          Discard
        </Button>
      </div>
    </li>
  );
}

function VarianceRow({ row }: { row: ProjectBaselineVarianceRow }) {
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {row.title ?? 'Removed milestone'}
      </th>
      <td>{row.baselineDate ?? '—'}</td>
      <td>{row.currentDate ?? '—'}</td>
      <td>{formatDelta(row.deltaDays)}</td>
    </tr>
  );
}

/** A signed day count: `+7` slipped later, `-3` pulled earlier, `On track` for zero, `—` unknown. */
function formatDelta(deltaDays: number | null): string {
  if (deltaDays === null) return '—';
  if (deltaDays === 0) return 'On track';
  return deltaDays > 0 ? `+${deltaDays}` : String(deltaDays);
}

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
