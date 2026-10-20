'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { ProjectTabs } from '../projects/ProjectTabs';
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
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';

type Translate = ReturnType<typeof useT>;

export interface ProjectObjectivesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** The project whose objectives this screen shows — from the `[projectId]` route segment. */
  projectId: string;
  client?: ApiClient;
}

const STATUS_LABELS: Readonly<Record<ProjectObjectiveStatus, MessageKey>> = {
  open: 'ProjectObjectivesScreen.statusOpen',
  met: 'ProjectObjectivesScreen.statusMet',
  missed: 'ProjectObjectivesScreen.statusMissed',
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
  const t = useT();

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
      title={t('ProjectObjectivesScreen.title')}
      description={t('ProjectObjectivesScreen.description')}
      eyebrow={t('ProjectObjectivesScreen.eyebrow')}
      topBar={
        <ProjectTabs
          organizationSlug={organizationSlug}
          projectId={projectId}
          current="objectives"
        />
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div className="tm-prj__grid tm-prj__grid--aside">
          <div className="tm-prj__col tm-prj__col--aside">
            <section className="tm-card tm-prj-card" aria-labelledby="tm-objectives-author">
              <h2 id="tm-objectives-author" className="tm-prj-eyebrow">
                {t('ProjectObjectivesScreen.setObjectiveHeading')}
              </h2>
              <form className="tm-stack" onSubmit={onSubmit} noValidate>
                <fieldset
                  className="tm-fieldset tm-stack tm-stack--loose"
                  disabled={create.isPending}
                >
                  <Field
                    label={t('ProjectObjectivesScreen.objectiveLabel')}
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    hint={t('ProjectObjectivesScreen.objectiveHint')}
                    required
                  />

                  <div className="tm-field">
                    <label className="tm-field__label" htmlFor="tm-objective-description">
                      {t('ProjectObjectivesScreen.descriptionLabel')}
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
                      {t('ProjectObjectivesScreen.descriptionHint')}
                    </span>
                  </div>

                  <Field
                    label={t('ProjectObjectivesScreen.targetLabel')}
                    name="target"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    hint={t('ProjectObjectivesScreen.targetHint')}
                  />
                </fieldset>

                {create.isError ? (
                  <InlineAlert tone="danger" title={t('ProjectObjectivesScreen.couldNotSet')} live>
                    {describeError(create.error, t)}
                  </InlineAlert>
                ) : null}

                <div className="tm-row">
                  <Button
                    type="submit"
                    tone="ink"
                    size="accessible"
                    loading={create.isPending}
                    loadingLabel={t('ProjectObjectivesScreen.saving')}
                    disabled={!canSubmit}
                  >
                    {t('ProjectObjectivesScreen.setObjectiveButton')}
                  </Button>
                </div>
              </form>
            </section>
          </div>
          <div className="tm-prj__col">
            {objectives.isError ? (
              <InlineAlert tone="danger" title={t('ProjectObjectivesScreen.couldNotLoad')} live>
                {describeError(objectives.error, t)}
              </InlineAlert>
            ) : null}

            {objectives.isPending ? (
              <LoadingRegion label={t('ProjectObjectivesScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!objectives.isPending && !objectives.isError && rows.length === 0 ? (
              <InlineAlert tone="neutral" title={t('ProjectObjectivesScreen.noObjectivesTitle')}>
                {t('ProjectObjectivesScreen.noObjectivesBody')}
              </InlineAlert>
            ) : null}

            {rows.length > 0 && transition.isError ? (
              <InlineAlert tone="danger" title={t('ProjectObjectivesScreen.couldNotUpdate')} live>
                {describeError(transition.error, t)}
              </InlineAlert>
            ) : null}

            {rows.length > 0 ? (
              <section className="tm-card tm-prj-card" aria-labelledby="tm-objectives-heading">
                <h2 id="tm-objectives-heading" className="tm-prj-eyebrow">
                  {t('ProjectObjectivesScreen.objectivesHeading')}
                </h2>
                <div
                  className="tm-table-scroll"
                  // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
                  // (WCAG 2.2 2.1.1), matching the sibling screens' tables.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                  tabIndex={0}
                  role="region"
                  aria-label={t('ProjectObjectivesScreen.tableAria')}
                >
                  <table className="tm-table">
                    <caption className="tm-visually-hidden">
                      {t('ProjectObjectivesScreen.captionLead')} {rows.length}{' '}
                      {t('ProjectObjectivesScreen.captionTail')}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('ProjectObjectivesScreen.colObjective')}</th>
                        <th scope="col">{t('ProjectObjectivesScreen.colTarget')}</th>
                        <th scope="col">{t('ProjectObjectivesScreen.colStatus')}</th>
                        <th scope="col">{t('ProjectObjectivesScreen.colOutcome')}</th>
                        <th scope="col">{t('ProjectObjectivesScreen.colLinkedWork')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((objective) => (
                        <ObjectiveRow
                          key={objective.id}
                          objective={objective}
                          t={t}
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
                {...(client ? { client } : {})}
              />
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function ObjectiveRow({
  objective,
  onTransition,
  busy,
  selected,
  onToggleLinks,
  t,
}: {
  objective: ProjectObjectiveSummary;
  onTransition: (status: ProjectObjectiveOutcome) => void;
  busy: boolean;
  selected: boolean;
  onToggleLinks: () => void;
  t: Translate;
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
      <td>{t(STATUS_LABELS[objective.status])}</td>
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
              {t('ProjectObjectivesScreen.markMet')}
            </Button>
            <Button
              type="button"
              tone="outline"
              size="accessible"
              onClick={() => onTransition('missed')}
              disabled={busy}
            >
              {t('ProjectObjectivesScreen.markMissed')}
            </Button>
          </div>
        ) : (
          <span className="tm-field__hint">{t('ProjectObjectivesScreen.noFurtherAction')}</span>
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
          {selected
            ? t('ProjectObjectivesScreen.hideLinkedWork')
            : t('ProjectObjectivesScreen.linkedWork')}
        </Button>
      </td>
    </tr>
  );
}

function describeError(error: unknown, t: Translate): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('ProjectObjectivesScreen.apiError');
  return t('ProjectObjectivesScreen.genericError');
}
