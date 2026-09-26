'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ObjectiveWorkLinksPanel } from './ObjectiveWorkLinksPanel';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createProjectObjective,
  listProjectObjectives,
  transitionProjectObjective,
} from '../../lib/api/project-objectives';
import type {
  ProjectObjectiveOutcome,
  ProjectObjectiveStatus,
  ProjectObjectiveSummary,
} from '../../lib/api/project-objectives';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectObjectivesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose objectives this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

const STATUS_LABELS: Readonly<Record<ProjectObjectiveStatus, string>> = {
  open: 'Open',
  met: 'Met',
  missed: 'Missed',
};

/**
 * **Project objectives (x124).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Projects: the objectives a project is working toward. This
 * screen records an objective — a name, an optional description and target — and lists the project's
 * objectives in creation order, then closes each open one as `met` or `missed`. It reads
 * `GET …/projects/:id/objectives` and writes `POST …/objectives` and `PATCH …/objectives/:id`, gated
 * on the server by `project.manage` (writes) and `work.read` (list).
 *
 * As on the sibling work/decision screens, **authorization is the API's**: a caller without the
 * capability gets the ordinary refusal, which `describeError()` turns into a sentence; the screen
 * never guesses a capability of its own and never renders blank on a refusal.
 */
export function ProjectObjectivesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectObjectivesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  /** The objective whose linked-work panel is open, if any (x138). */
  const [selectedObjective, setSelectedObjective] = useState<{
    id: string;
    name: string;
  } | null>(null);

  const objectives = useQuery({
    queryKey: ['project-objectives', organizationSlug, projectId],
    queryFn: () => listProjectObjectives(api, organizationSlug, projectId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['project-objectives', organizationSlug, projectId],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createProjectObjective(api, organizationSlug, projectId, {
        name: name.trim(),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(target.trim() === '' ? {} : { target: target.trim() }),
      }),
    onSuccess: async () => {
      setName('');
      setDescription('');
      setTarget('');
      await refetch();
    },
  });

  const transition = useMutation({
    mutationFn: (vars: { objectiveId: string; status: ProjectObjectiveOutcome }) =>
      transitionProjectObjective(api, organizationSlug, projectId, vars.objectiveId, vars.status),
    onSuccess: refetch,
  });

  const rows = useMemo(() => objectives.data ?? [], [objectives.data]);
  const canSubmit = name.trim() !== '';

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
      title="Project objectives"
      description="What this project is working toward, and whether it was met."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-objectives-author">
        <h2 id="tm-objectives-author" className="tm-eyebrow">
          Set an objective
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
            <Field
              label="Objective"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="One line. What this project is aiming at."
              required
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-objective-description">
                Description
              </label>
              <textarea
                id="tm-objective-description"
                name="description"
                className="tm-field__control tm-field__control--multiline"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-describedby="tm-objective-description-hint"
              />
              <span className="tm-field__hint" id="tm-objective-description-hint">
                Optional. The objective in full, and why it matters.
              </span>
            </div>

            <Field
              label="Target"
              name="target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              hint="Optional. What success looks like, e.g. “≤ 3 days” or “ship by Q3”."
            />
          </fieldset>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not set the objective" live>
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
              Set objective
            </Button>
          </div>
        </form>
      </section>

      {objectives.isError ? (
        <InlineAlert tone="danger" title="Could not load the objectives" live>
          {describeError(objectives.error)}
        </InlineAlert>
      ) : null}

      {objectives.isPending ? (
        <LoadingRegion label="Loading the project's objectives.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!objectives.isPending && !objectives.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No objectives yet">
          This project has no objectives. Set the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && transition.isError ? (
        <InlineAlert tone="danger" title="Could not update the objective" live>
          {describeError(transition.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-objectives-heading">
          <h2 id="tm-objectives-heading" className="tm-eyebrow">
            Objectives
          </h2>
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Project objectives"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Objectives for this project, in creation order, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Objective</th>
                  <th scope="col">Target</th>
                  <th scope="col">Status</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Linked work</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((objective) => (
                  <ObjectiveRow
                    key={objective.id}
                    objective={objective}
                    onTransition={(status) =>
                      transition.mutate({ objectiveId: objective.id, status })
                    }
                    busy={transition.isPending}
                    selected={selectedObjective?.id === objective.id}
                    onToggleLinks={() =>
                      setSelectedObjective((current) =>
                        current?.id === objective.id
                          ? null
                          : { id: objective.id, name: objective.name },
                      )
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {selectedObjective ? (
        <ObjectiveWorkLinksPanel
          organizationSlug={organizationSlug}
          objectiveId={selectedObjective.id}
          objectiveName={selectedObjective.name}
          client={client}
        />
      ) : null}
    </AppShell>
  );
}

function ObjectiveRow({
  objective,
  onTransition,
  busy,
  selected,
  onToggleLinks,
}: {
  objective: ProjectObjectiveSummary;
  onTransition: (status: ProjectObjectiveOutcome) => void;
  busy: boolean;
  selected: boolean;
  onToggleLinks: () => void;
}) {
  return (
    <tr>
      <th scope="row" className="tm-table__title">
        {objective.name}
        {objective.description ? (
          <span className="tm-field__hint">{objective.description}</span>
        ) : null}
      </th>
      <td>{objective.target ?? <span className="tm-field__hint">—</span>}</td>
      <td>{STATUS_LABELS[objective.status]}</td>
      <td>
        {objective.status === 'open' ? (
          <div className="tm-row">
            <Button
              type="button"
              tone="ink"
              size="accessible"
              onClick={() => onTransition('met')}
              disabled={busy}
            >
              Mark met
            </Button>
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => onTransition('missed')}
              disabled={busy}
            >
              Mark missed
            </Button>
          </div>
        ) : (
          <span className="tm-field__hint">No further action.</span>
        )}
      </td>
      <td>
        <Button
          type="button"
          tone="outline"
          size="accessible"
          onClick={onToggleLinks}
          aria-pressed={selected}
        >
          {selected ? 'Hide linked work' : 'Linked work'}
        </Button>
      </td>
    </tr>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
