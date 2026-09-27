'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  linkMilestoneDependency,
  listMilestoneDependencies,
  unlinkMilestoneDependency,
} from '../../lib/api/milestone-links';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MilestoneDependenciesPanelProps {
  organizationSlug: string;
  /** The milestone whose dependencies this panel shows. */
  milestoneId: string;
  /** The milestone's title, for the panel heading and accessible labels. */
  milestoneTitle: string;
  client?: ApiClient;
}

/**
 * **Milestone dependencies (x236).**
 *
 * `38-MODULE-MAP` §Projects & portfolio: the milestones one milestone depends on. Distinct from the
 * x139 milestone screens (`MilestoneLifecycleControls`, `PortalMilestonesScreen`) — this panel is the
 * dependency control. It lists a milestone's prerequisites in creation order, links one by id, and
 * unlinks one. It reads `GET …/projects/milestones/:id/links` and writes `POST …/links` and
 * `DELETE …/links/:dependsOnMilestoneId`, all gated on the server by `project.manage`.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the panel never guesses a
 * capability of its own and never renders blank on a refusal.
 */
export function MilestoneDependenciesPanel({
  organizationSlug,
  milestoneId,
  milestoneTitle,
  client,
}: MilestoneDependenciesPanelProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [dependsOnMilestoneId, setDependsOnMilestoneId] = useState('');

  const headingId = `tm-milestone-deps-${milestoneId}`;

  const dependencies = useQuery({
    queryKey: ['milestone-dependencies', organizationSlug, milestoneId],
    queryFn: () => listMilestoneDependencies(api, organizationSlug, milestoneId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['milestone-dependencies', organizationSlug, milestoneId],
    });
  }

  const linkMutation = useMutation({
    mutationFn: () =>
      linkMilestoneDependency(api, organizationSlug, milestoneId, dependsOnMilestoneId.trim()),
    onSuccess: async () => {
      setDependsOnMilestoneId('');
      await refetch();
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: (targetId: string) =>
      unlinkMilestoneDependency(api, organizationSlug, milestoneId, targetId),
    onSuccess: refetch,
  });

  const rows = useMemo(() => dependencies.data ?? [], [dependencies.data]);
  const canSubmit = dependsOnMilestoneId.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || linkMutation.isPending) return;
    linkMutation.mutate();
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        Depends on — {milestoneTitle}
      </h3>

      <form className="tm-stack" onSubmit={onSubmit} noValidate>
        <fieldset
          className="tm-fieldset tm-stack tm-stack--loose"
          disabled={linkMutation.isPending}
        >
          <Field
            label="Prerequisite milestone ID"
            name="dependsOnMilestoneId"
            value={dependsOnMilestoneId}
            onChange={(event) => setDependsOnMilestoneId(event.target.value)}
            hint="The ID of another milestone in this project that must come first."
            required
          />
        </fieldset>

        {linkMutation.isError ? (
          <InlineAlert tone="danger" title="Could not add the dependency" live>
            {describeError(linkMutation.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={linkMutation.isPending}
            loadingLabel="Linking"
            disabled={!canSubmit}
          >
            Add dependency
          </Button>
        </div>
      </form>

      {dependencies.isError ? (
        <InlineAlert tone="danger" title="Could not load the dependencies" live>
          {describeError(dependencies.error)}
        </InlineAlert>
      ) : null}

      {dependencies.isPending ? (
        <LoadingRegion label="Loading the milestone's dependencies.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!dependencies.isPending && !dependencies.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No dependencies yet">
          This milestone depends on nothing yet. Add the first prerequisite above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && unlinkMutation.isError ? (
        <InlineAlert tone="danger" title="Could not remove the dependency" live>
          {describeError(unlinkMutation.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
          // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label={`Milestones ${milestoneTitle} depends on`}
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Milestones this one depends on, in link order, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Prerequisite</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.linkId}>
                  <th scope="row" className="tm-table__title">
                    {row.dependsOnTitle}
                  </th>
                  <td>{row.dependsOnStatus}</td>
                  <td>
                    <Button
                      type="button"
                      tone="outline"
                      size="accessible"
                      onClick={() => unlinkMutation.mutate(row.dependsOnMilestoneId)}
                      disabled={unlinkMutation.isPending}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
