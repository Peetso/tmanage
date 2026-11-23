'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import {
  fetchProjectStageSet,
  listStageSets,
  type StageSetView,
  type StageView,
} from '../../../lib/api/work-stages';
import { currentStage, effectiveSetForWork } from './stage-model';

export function stageSetsKey(organizationSlug: string) {
  return ['work-stage-sets', organizationSlug] as const;
}

export function projectStageSetKey(organizationSlug: string, projectId: string) {
  return ['project-stage-set', organizationSlug, projectId] as const;
}

/** The stage sets of the workspace, and the one a project uses. */
export function useStageSets(api: ApiClient, organizationSlug: string) {
  return useQuery({
    queryKey: stageSetsKey(organizationSlug),
    queryFn: () => listStageSets(api, organizationSlug),
  });
}

export function useProjectStageSet(
  api: ApiClient,
  organizationSlug: string,
  projectId: string | null,
) {
  return useQuery({
    queryKey: projectStageSetKey(organizationSlug, projectId ?? ''),
    queryFn: () => fetchProjectStageSet(api, organizationSlug, projectId ?? ''),
    enabled: projectId !== null && projectId !== '',
  });
}

/** The set one work uses, the stage it is on, and the sets it may switch to. */
export interface WorkStages {
  readonly set: StageSetView | null;
  readonly stage: StageView | null;
  readonly projectSet: StageSetView | null;
  /** Workspace sets and this project's own set: the ones a work may use (API rule). */
  readonly choices: readonly StageSetView[];
  readonly loading: boolean;
}

export function useWorkStages(
  api: ApiClient,
  organizationSlug: string,
  work: { readonly projectId: string; readonly stageId?: string | null; readonly state: string },
): WorkStages {
  const sets = useStageSets(api, organizationSlug);
  const project = useProjectStageSet(api, organizationSlug, work.projectId);
  const projectSet = project.data?.stageSet ?? null;
  const set = effectiveSetForWork(work.stageId, sets.data ?? [], projectSet);
  const choices = (sets.data ?? []).filter(
    (candidate) => candidate.projectId === null || candidate.projectId === work.projectId,
  );
  return {
    set,
    stage: currentStage(set, work.stageId, work.state),
    projectSet,
    choices,
    loading: sets.isPending || project.isPending,
  };
}
