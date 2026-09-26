'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createOrgObjective,
  listOrgObjectives,
  transitionOrgObjective,
} from '../../lib/api/org-objectives';
import type {
  OrgObjectiveOutcome,
  OrgObjectiveStatus,
  OrgObjectiveSummary,
} from '../../lib/api/org-objectives';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface OrgObjectivesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const STATUS_LABELS: Readonly<Record<OrgObjectiveStatus, string>> = {
  open: 'Open',
  met: 'Met',
  missed: 'Missed',
};

/**
 * **Organization objectives / OKRs (x136).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Projects: the objectives the whole organization is working
 * toward — the org-level counterpart of `ProjectObjectivesScreen` (x124), with no project. This screen
 * records an objective — a name, an optional description and target — and lists the organization's
 * objectives in creation order, then closes each open one as `met` or `missed`. It reads
 * `GET …/objectives` and writes `POST …/objectives` and `PATCH …/objectives/:id`, gated on the server
 * by `project.manage` (writes) and `work.read` (list).
 *
 * As on the sibling work/decision screens, **authorization is the API's**: a caller without the
 * capability gets the ordinary refusal, which `describeError()` turns into a sentence; the screen
 * never guesses a capability of its own and never renders blank on a refusal.
 */
export function OrgObjectivesScreen({
  organizationSlug,
  organizationName,
  client,
}: OrgObjectivesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');

  const objectives = useQuery({
    queryKey: ['org-objectives', organizationSlug],
    queryFn: () => listOrgObjectives(api, organizationSlug),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['org-objectives', organizationSlug],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createOrgObjective(api, organizationSlug, {
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
    mutationFn: (vars: { objectiveId: string; status: OrgObjectiveOutcome }) =>
      transitionOrgObjective(api, organizationSlug, vars.objectiveId, vars.status),
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
      title="Organization objectives"
      description="What the whole organization is working toward, and whether it was met."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-org-objectives-author">
        <h2 id="tm-org-objectives-author" className="tm-eyebrow">
          Set an objective
        </h2>
        <form className="tm-stack" onSubmit={onSubmit} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
            <Field
              label="Objective"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="One line. What the organization is aiming at."
              required
            />

            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-org-objective-description">
                Description
              </label>
              <textarea
                id="tm-org-objective-description"
                name="description"
                className="tm-field__control tm-field__control--multiline"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                aria-describedby="tm-org-objective-description-hint"
              />
              <span className="tm-field__hint" id="tm-org-objective-description-hint">
                Optional. The objective in full, and why it matters.
              </span>
            </div>

            <Field
              label="Target"
              name="target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              hint="Optional. What success looks like, e.g. “+40% ARR” or “ship by Q3”."
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
        <LoadingRegion label="Loading the organization's objectives.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!objectives.isPending && !objectives.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No objectives yet">
          This organization has no objectives. Set the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 && transition.isError ? (
        <InlineAlert tone="danger" title="Could not update the objective" live>
          {describeError(transition.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-org-objectives-heading">
          <h2 id="tm-org-objectives-heading" className="tm-eyebrow">
            Objectives
          </h2>
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Organization objectives"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Objectives for this organization, in creation order, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Objective</th>
                  <th scope="col">Target</th>
                  <th scope="col">Status</th>
                  <th scope="col">Outcome</th>
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </AppShell>
  );
}

function ObjectiveRow({
  objective,
  onTransition,
  busy,
}: {
  objective: OrgObjectiveSummary;
  onTransition: (status: OrgObjectiveOutcome) => void;
  busy: boolean;
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
    </tr>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
