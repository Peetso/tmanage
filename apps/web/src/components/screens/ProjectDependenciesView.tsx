'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createProjectDependency,
  deleteProjectDependency,
  listProjectDependencies,
  type ProjectDependency,
} from '../../lib/api/project-dependencies';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectDependenciesViewProps {
  organizationSlug: string;
  /** The project whose dependency graph this view shows. */
  projectId: string;
  /** The project's name, for the headings and accessible labels. */
  projectName: string;
  client?: ApiClient;
}

/**
 * **Project dependencies (x309).**
 *
 * `38-MODULE-MAP` §Projects & portfolio (cross-project dependencies), `22-SCREEN` §Portfolio: the
 * directed edges between whole projects. It shows two lists — the projects this one blocks
 * (`blocking`) and the projects that block it (`blockedBy`) — records a new "blocks" edge by id with
 * an optional note, and removes one. It reads `GET …/projects/:id/dependencies` and writes
 * `POST …/dependencies` and `DELETE …/dependencies/:blockedProjectId`, all gated on the server by
 * `project.manage`. Distinct from the milestone-level (`MilestoneDependenciesPanel`) and item-level
 * (`WorkItemDependenciesScreen`) dependency screens.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence; the view never guesses a
 * capability of its own and never renders blank on a refusal.
 */
export function ProjectDependenciesView({
  organizationSlug,
  projectId,
  projectName,
  client,
}: ProjectDependenciesViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [blockedProjectId, setBlockedProjectId] = useState('');
  const [note, setNote] = useState('');

  const headingId = `tm-project-deps-${projectId}`;

  const graph = useQuery({
    queryKey: ['project-dependencies', organizationSlug, projectId],
    queryFn: () => listProjectDependencies(api, organizationSlug, projectId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['project-dependencies', organizationSlug, projectId],
    });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createProjectDependency(api, organizationSlug, projectId, {
        blockedProjectId: blockedProjectId.trim(),
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: async () => {
      setBlockedProjectId('');
      setNote('');
      await refetch();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (targetId: string) =>
      deleteProjectDependency(api, organizationSlug, projectId, targetId),
    onSuccess: refetch,
  });

  const blocking = useMemo(() => graph.data?.blocking ?? [], [graph.data]);
  const blockedBy = useMemo(() => graph.data?.blockedBy ?? [], [graph.data]);
  const canSubmit = blockedProjectId.trim() !== '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <section className="tm-panel tm-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="tm-eyebrow">
        Dependencies — {projectName}
      </h3>

      <form className="tm-stack" onSubmit={onSubmit} noValidate>
        <fieldset
          className="tm-fieldset tm-stack tm-stack--loose"
          disabled={createMutation.isPending}
        >
          <Field
            label="Blocked project ID"
            name="blockedProjectId"
            value={blockedProjectId}
            onChange={(event) => setBlockedProjectId(event.target.value)}
            hint="The ID of a project that is blocked by this one (it depends on this project)."
            required
          />
          <Field
            label="Note (optional)"
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            hint="Why this project blocks the other. Up to 500 characters."
          />
        </fieldset>

        {createMutation.isError ? (
          <InlineAlert tone="danger" title="Could not add the dependency" live>
            {describeError(createMutation.error)}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={createMutation.isPending}
            loadingLabel="Adding"
            disabled={!canSubmit}
          >
            Add dependency
          </Button>
        </div>
      </form>

      {graph.isError ? (
        <InlineAlert tone="danger" title="Could not load the dependencies" live>
          {describeError(graph.error)}
        </InlineAlert>
      ) : null}

      {graph.isPending ? (
        <LoadingRegion label="Loading the project's dependencies.">
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {removeMutation.isError ? (
        <InlineAlert tone="danger" title="Could not remove the dependency" live>
          {describeError(removeMutation.error)}
        </InlineAlert>
      ) : null}

      {!graph.isPending && !graph.isError ? (
        <>
          <DependencyTable
            caption={`Projects ${projectName} blocks`}
            emptyTitle="Blocks nothing yet"
            emptyBody="This project does not block any other yet. Add the first above."
            farLabel="Blocked project"
            rows={blocking}
            onRemove={(row) => removeMutation.mutate(row.blockedProjectId)}
            removing={removeMutation.isPending}
            removable
          />
          <DependencyTable
            caption={`Projects that block ${projectName}`}
            emptyTitle="Not blocked by anything"
            emptyBody="No other project blocks this one."
            farLabel="Blocking project"
            rows={blockedBy}
            removable={false}
          />
        </>
      ) : null}
    </section>
  );
}

interface DependencyTableProps {
  caption: string;
  emptyTitle: string;
  emptyBody: string;
  farLabel: string;
  rows: readonly ProjectDependency[];
  removable: boolean;
  onRemove?: (row: ProjectDependency) => void;
  removing?: boolean;
}

function DependencyTable({
  caption,
  emptyTitle,
  emptyBody,
  farLabel,
  rows,
  removable,
  onRemove,
  removing,
}: DependencyTableProps) {
  if (rows.length === 0) {
    return (
      <InlineAlert tone="neutral" title={emptyTitle}>
        {emptyBody}
      </InlineAlert>
    );
  }

  return (
    <div
      className="tm-table-scroll"
      // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
      // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      role="region"
      aria-label={caption}
    >
      <table className="tm-table">
        <caption className="tm-visually-hidden">
          {caption}, {rows.length} shown.
        </caption>
        <thead>
          <tr>
            <th scope="col">{farLabel}</th>
            <th scope="col">Status</th>
            <th scope="col">Note</th>
            {removable ? <th scope="col">Action</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.edgeId}>
              <th scope="row" className="tm-table__title">
                {row.projectName}
              </th>
              <td>{row.projectStatus}</td>
              <td>{row.note ?? '—'}</td>
              {removable ? (
                <td>
                  <Button
                    type="button"
                    tone="outline"
                    size="accessible"
                    onClick={() => onRemove?.(row)}
                    disabled={removing}
                  >
                    Remove
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
