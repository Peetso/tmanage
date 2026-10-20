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
import { useT } from '../../lib/i18n/use-t';

type Translate = ReturnType<typeof useT>;

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
  const t = useT();

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
      title={t('ProjectPhasesView.title')}
      description={t('ProjectPhasesView.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-phase-author">
        <h2 id="tm-phase-author" className="tm-eyebrow">
          {t('ProjectPhasesView.addPhaseHeading')}
        </h2>
        <form className="tm-stack" onSubmit={onDefine} noValidate>
          <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={create.isPending}>
            <Field
              label={t('ProjectPhasesView.phaseNameLabel')}
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              hint={t('ProjectPhasesView.phaseNameHint')}
              required
            />
          </fieldset>

          {create.isError ? (
            <InlineAlert tone="danger" title={t('ProjectPhasesView.couldNotAdd')} live>
              {describeError(create.error, t)}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel={t('ProjectPhasesView.saving')}
              disabled={!canDefine}
            >
              {t('ProjectPhasesView.addPhaseButton')}
            </Button>
          </div>
        </form>
      </section>

      {phases.isError ? (
        <InlineAlert tone="danger" title={t('ProjectPhasesView.couldNotLoad')} live>
          {describeError(phases.error, t)}
        </InlineAlert>
      ) : null}

      {phases.isPending ? (
        <LoadingRegion label={t('ProjectPhasesView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!phases.isPending && !phases.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title={t('ProjectPhasesView.noPhasesTitle')}>
          {t('ProjectPhasesView.noPhasesBody')}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-phases-heading">
          <h2 id="tm-phases-heading" className="tm-eyebrow">
            {t('ProjectPhasesView.phasesHeading')}
          </h2>
          <div
            className="tm-table-scroll"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t('ProjectPhasesView.regionAria')}
          >
            <ol className="tm-row" aria-label={t('ProjectPhasesView.phaseColumnsAria')}>
              {rows.map((phase) => (
                <PhaseColumn
                  key={phase.id}
                  phase={phase}
                  onDelete={() => remove.mutate(phase.id)}
                  busy={remove.isPending}
                  t={t}
                />
              ))}
            </ol>
          </div>
          {remove.isError ? (
            <InlineAlert tone="danger" title={t('ProjectPhasesView.couldNotDelete')} live>
              {describeError(remove.error, t)}
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-panel tm-stack" aria-labelledby="tm-assign-heading">
          <h2 id="tm-assign-heading" className="tm-eyebrow">
            {t('ProjectPhasesView.assignHeading')}
          </h2>
          <form className="tm-stack" onSubmit={onAssign} noValidate>
            <fieldset className="tm-fieldset tm-stack tm-stack--loose" disabled={assign.isPending}>
              <Field
                label={t('ProjectPhasesView.milestoneIdLabel')}
                name="milestoneId"
                value={milestoneId}
                onChange={(event) => setMilestoneId(event.target.value)}
                hint={t('ProjectPhasesView.milestoneIdHint')}
                required
              />
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-assign-phase">
                  {t('ProjectPhasesView.phaseLabel')}
                </label>
                <select
                  id="tm-assign-phase"
                  name="phaseId"
                  className="tm-field__control"
                  value={targetPhaseId}
                  onChange={(event) => setTargetPhaseId(event.target.value)}
                >
                  <option value="">{t('ProjectPhasesView.choosePhase')}</option>
                  {rows.map((phase) => (
                    <option key={phase.id} value={phase.id}>
                      {phase.name}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            {assign.isError ? (
              <InlineAlert tone="danger" title={t('ProjectPhasesView.couldNotAssign')} live>
                {describeError(assign.error, t)}
              </InlineAlert>
            ) : null}

            <div className="tm-row">
              <Button
                type="submit"
                tone="ink"
                size="accessible"
                loading={assign.isPending}
                loadingLabel={t('ProjectPhasesView.assigning')}
                disabled={!canAssign}
              >
                {t('ProjectPhasesView.assignButton')}
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
  t,
}: {
  phase: ProjectPhaseSummary;
  onDelete: () => void;
  busy: boolean;
  t: Translate;
}) {
  return (
    <li className="tm-stat tm-stack">
      <div className="tm-row">
        <span className="tm-stat__value">{phase.name}</span>
        <Button tone="destructive" size="compact" onClick={onDelete} disabled={busy}>
          {t('ProjectPhasesView.delete')}
        </Button>
      </div>
      {phase.milestoneIds.length === 0 ? (
        <span className="tm-field__hint">{t('ProjectPhasesView.noMilestonesYet')}</span>
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

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectPhasesView.apiError');
  return t('ProjectPhasesView.genericError');
}
