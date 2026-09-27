'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  assignMilestoneToPhase,
  createProjectPhase,
  deleteProjectPhase,
  listProjectPhases,
} from '../../lib/api/project-phases';
import type { ProjectPhaseSummary } from '../../lib/api/project-phases';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectPhasesViewProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose timeline phases this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

/**
 * **Project timeline phases (x294).**
 *
 * `22-SCREEN` PRJ timeline/phases, `38-MODULE-MAP` §Projects & portfolio: a project manager groups a
 * project's milestones into named, ordered phases so the timeline reads as phases. This screen
 * defines a phase, lists the phases as timeline columns (each showing the milestones placed in it),
 * deletes a phase, and assigns a milestone to a phase by id. It reads `GET …/projects/:id/phases`
 * and writes `POST …/phases`, `DELETE …/phases/:phaseId`, and
 * `PUT …/milestones/:milestoneId/phase/:phaseId`, all gated on the server by `project.manage`.
 *
 * As on the sibling screens, **authorization is the API's**: a caller without the capability gets the
 * ordinary refusal, which `describeError()` turns into a sentence.
 */
export function ProjectPhasesView({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectPhasesViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [targetPhaseId, setTargetPhaseId] = useState('');

  const phases = useQuery({
    queryKey: ['project-phases', organizationSlug, projectId],
    queryFn: () => listProjectPhases(api, organizationSlug, projectId),
  });

  async function refetch() {
    await queryClient.invalidateQueries({
      queryKey: ['project-phases', organizationSlug, projectId],
    });
  }

  const create = useMutation({
    mutationFn: () =>
      createProjectPhase(api, organizationSlug, projectId, {
        name: name.trim(),
        position: rows.length,
      }),
    onSuccess: async () => {
      setName('');
      await refetch();
    },
  });

  const remove = useMutation({
    mutationFn: (phaseId: string) => deleteProjectPhase(api, organizationSlug, phaseId),
    onSuccess: refetch,
  });

  const assign = useMutation({
    mutationFn: () =>
      assignMilestoneToPhase(api, organizationSlug, milestoneId.trim(), targetPhaseId),
    onSuccess: async () => {
      setMilestoneId('');
      setTargetPhaseId('');
      await refetch();
    },
  });

  const rows = useMemo(() => phases.data ?? [], [phases.data]);
  const canDefine = name.trim() !== '';
  const canAssign = milestoneId.trim() !== '' && targetPhaseId !== '';

  function onDefine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDefine || create.isPending) return;
    create.mutate();
  }

  function onAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAssign || assign.isPending) return;
    assign.mutate();
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Timeline phases"
      description="Group this project's milestones into named, ordered phases so the timeline reads as phases."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-phase-author">
        <h2 id="tm-phase-author" className="tm-eyebrow">
          Add a phase
        </h2>
        <form className="tm-stack" onSubmit={onDefine} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
            <Field
              label="Phase name"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint="One label. For example, Discovery, Build, or Launch."
              required
            />
          </fieldset>

          {create.isError ? (
            <InlineAlert tone="danger" title="Could not add the phase" live>
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
              disabled={!canDefine}
            >
              Add phase
            </Button>
          </div>
        </form>
      </section>

      {phases.isError ? (
        <InlineAlert tone="danger" title="Could not load the phases" live>
          {describeError(phases.error)}
        </InlineAlert>
      ) : null}

      {phases.isPending ? (
        <LoadingRegion label="Loading the project's phases.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!phases.isPending && !phases.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No phases yet">
          This project has no phases. Add the first one above.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-phases-heading">
          <h2 id="tm-phases-heading" className="tm-eyebrow">
            Phases
          </h2>
          <div
            className="tm-table-scroll"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Project timeline phases"
          >
            <ol className="tm-row" aria-label="Phase columns">
              {rows.map((phase) => (
                <PhaseColumn
                  key={phase.id}
                  phase={phase}
                  onDelete={() => remove.mutate(phase.id)}
                  busy={remove.isPending}
                />
              ))}
            </ol>
          </div>
          {remove.isError ? (
            <InlineAlert tone="danger" title="Could not delete the phase" live>
              {describeError(remove.error)}
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-assign-heading">
          <h2 id="tm-assign-heading" className="tm-eyebrow">
            Assign a milestone
          </h2>
          <form className="tm-stack" onSubmit={onAssign} noValidate>
            <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={assign.isPending}>
              <Field
                label="Milestone id"
                name="milestoneId"
                value={milestoneId}
                onChange={(event) => setMilestoneId(event.target.value)}
                hint="The milestone to place into a phase."
                required
              />
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-assign-phase">
                  Phase
                </label>
                <select
                  id="tm-assign-phase"
                  name="phaseId"
                  className="tm-field__control"
                  value={targetPhaseId}
                  onChange={(event) => setTargetPhaseId(event.target.value)}
                >
                  <option value="">Choose a phase…</option>
                  {rows.map((phase) => (
                    <option key={phase.id} value={phase.id}>
                      {phase.name}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            {assign.isError ? (
              <InlineAlert tone="danger" title="Could not assign the milestone" live>
                {describeError(assign.error)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={assign.isPending}
                loadingLabel="Assigning"
                disabled={!canAssign}
              >
                Assign to phase
              </Button>
            </div>
          </form>
        </section>
      ) : null}
    </AppShell>
  );
}

/** One phase column on the timeline, listing the milestones placed in it. */
function PhaseColumn({
  phase,
  onDelete,
  busy,
}: {
  phase: ProjectPhaseSummary;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="tm-stat tm-stack">
      <div className="tm-row">
        <span className="tm-stat__value">{phase.name}</span>
        <Button tone="destructive" size="compact" onClick={onDelete} disabled={busy}>
          Delete
        </Button>
      </div>
      {phase.milestoneIds.length === 0 ? (
        <span className="tm-field__hint">No milestones yet.</span>
      ) : (
        <ul className="tm-stack">
          {phase.milestoneIds.map((id) => (
            <li key={id} className="tm-field__hint">
              {id}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
