'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { ProjectTabs } from '../../projects/ProjectTabs';
import type { ApiClient } from '../../../lib/api/client';
import { browserApiClient } from '../../../lib/api/browser-client';
import { getProject } from '../../../lib/api/projects';
import { setProjectStageSet, type StageSetView } from '../../../lib/api/work-stages';
import { useA6T } from '../DueDatePicker';
import { BUILT_IN_SET } from './stage-editor-model';
import { orderedStages } from './stage-model';
import { NewStageSetDialog } from './NewStageSetDialog';
import { useStageSetWrites } from './use-stage-editor';
import { useProjectStageSet, useStageSets } from './use-work-stages';
import { StageCapsule, useStageName } from './WorkStageControl';
import './stages-editor.css';

export interface ProjectStagesScreenProps {
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly projectId: string;
  readonly client?: ApiClient;
}

/**
 * **Project → Stages** (W-WEB-5; Figma W8 `937:100226` EN, `937:100366` AR). A project either
 * has its own stages (a set chosen from the workspace's, or one made for it) or uses the
 * workspace's. Its board columns are the chosen set's stages. Changing the set is the project
 * managers' (`project.manage`); the API moves each work to a fitting stage of the new set.
 */
export function ProjectStagesScreen({
  organizationSlug,
  organizationName,
  projectId,
  client,
}: ProjectStagesScreenProps) {
  const t = useA6T();
  const api = client ?? browserApiClient();
  const name = useStageName();
  const ids = { own: useId(), workspace: useId(), select: useId(), columns: useId() };
  const project = useQuery({
    queryKey: ['project', organizationSlug, projectId],
    queryFn: () => getProject(api, organizationSlug, projectId),
  });
  const effective = useProjectStageSet(api, organizationSlug, projectId);
  const stored = useStageSets(api, organizationSlug);
  const writes = useStageSetWrites(organizationSlug);
  const [creating, setCreating] = useState(false);

  const all = stored.data ?? [];
  const workspaceSet = all.find((set) => set.isDefault) ?? BUILT_IN_SET;
  // A project may use a workspace set or one of its own (the API's rule for `PUT …/stage-set`).
  const choices = all.filter((set) => set.projectId === null || set.projectId === projectId);
  const own = effective.data?.source === 'project' ? effective.data.stageSet : null;

  const point = (stageSetId: string | null) =>
    void writes.run(async () => {
      await setProjectStageSet(api, organizationSlug, projectId, stageSetId);
    });

  function chooseOwn() {
    if (own) return;
    const first = choices.find((set) => !set.isDefault);
    if (first) point(first.id);
    else setCreating(true);
  }

  const line = (set: StageSetView) =>
    `${set.isBuiltIn ? t('WorkStages.builtInSet') : set.name}: ${orderedStages(set.stages)
      .map((stage) => name(stage, set))
      .join(' · ')}`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      header="compact"
      title={project.data?.name ?? t('WorkStages.editor.projectTitle')}
      titleMeta={<span className="tm-stg-project__meta">{t('WorkStages.editor.title')}</span>}
      topBar={
        <ProjectTabs organizationSlug={organizationSlug} projectId={projectId} current="stages" />
      }
    >
      <div className="tm-stg-project">
        {effective.isPending || stored.isPending ? (
          <div className="tm-stg-page__loading" aria-busy="true">
            <span className="tm-visually-hidden">{t('WorkStages.editor.loading')}</span>
            <Skeleton height="var(--app-row)" />
            <Skeleton height="var(--app-row)" />
          </div>
        ) : effective.isError || stored.isError ? (
          <InlineAlert tone="danger" title={t('WorkStages.editor.loadFailed')} live>
            <Button
              tone="outline"
              size="header"
              onClick={() => {
                void effective.refetch();
                void stored.refetch();
              }}
            >
              {t('WorkStages.editor.retry')}
            </Button>
          </InlineAlert>
        ) : (
          <fieldset className="tm-stg-project__choices" disabled={writes.pending}>
            <legend className="tm-visually-hidden">{t('WorkStages.editor.projectLegend')}</legend>
            <div className="tm-stg-choice" data-checked={own ? true : undefined}>
              <input
                id={ids.own}
                type="radio"
                name={ids.own}
                checked={own !== null}
                onChange={chooseOwn}
              />
              <div className="tm-stg-choice__body">
                <label htmlFor={ids.own} className="tm-stg-choice__title">
                  {t('WorkStages.editor.projectOwn')}
                </label>
                {own ? (
                  <>
                    <span className="tm-stg-select" data-wide>
                      <label htmlFor={ids.select} className="tm-visually-hidden">
                        {t('WorkStages.stageSet')}
                      </label>
                      <select
                        id={ids.select}
                        className="tm-stg-select__control"
                        value={own.id}
                        onChange={(event) => point(event.target.value)}
                      >
                        {choices.map((set) => (
                          <option key={set.id} value={set.id}>
                            {set.name}
                          </option>
                        ))}
                      </select>
                    </span>
                    <p id={ids.columns} className="tm-stg-choice__caption">
                      {t('WorkStages.editor.boardColumns')}
                    </p>
                    <ul className="tm-stg-columns" aria-labelledby={ids.columns}>
                      {orderedStages(own.stages).map((stage) => (
                        <li key={stage.id} className="tm-stg-columns__item">
                          <StageCapsule stage={stage} name={name(stage, own)} />
                        </li>
                      ))}
                    </ul>
                    <span className="tm-stg-choice__actions">
                      <Link
                        className="tm-stg-choice__edit"
                        href={`/${organizationSlug}/settings/stages?set=${encodeURIComponent(own.id)}`}
                      >
                        {t('WorkStages.editor.editThisSet')}
                      </Link>
                      <Button tone="text" size="header" onClick={() => setCreating(true)}>
                        {t('WorkStages.newSet')}
                      </Button>
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="tm-stg-choice" data-checked={own ? undefined : true}>
              <input
                id={ids.workspace}
                type="radio"
                name={ids.own}
                checked={own === null}
                onChange={() => point(null)}
              />
              <div className="tm-stg-choice__body">
                <label htmlFor={ids.workspace} className="tm-stg-choice__title">
                  {t('WorkStages.editor.projectWorkspace')}
                </label>
                <p className="tm-stg-choice__caption">
                  <bdi>{line(workspaceSet)}</bdi>
                </p>
              </div>
            </div>
          </fieldset>
        )}
        {writes.failure ? (
          <InlineAlert tone="danger" title={t('WorkStages.editor.notSaved')} live>
            {writes.failure}
          </InlineAlert>
        ) : null}
      </div>
      {creating ? (
        <NewStageSetDialog
          api={api}
          organizationSlug={organizationSlug}
          projectId={projectId}
          sets={all}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      ) : null}
    </AppShell>
  );
}
