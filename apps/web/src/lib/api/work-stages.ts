import type { ApiClient } from './client';
import type { WorkItemSummary } from './work-items';

/**
 * Work area D1 (2026-11-23) — renamable stages and own stage sets. A stage is a named place inside
 * one of the work states (`stateKey`), shown in one of four groups. Reading is `work.read`; a
 * workspace set is changed by owners/admins, a project's own set by that project's managers.
 * Moving a work to a stage in another state runs the ordinary state move on the server.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projections in
 * the `e2e/contracts` shape check so the two cannot drift.
 */

export type StageGroup = 'not_started' | 'in_progress' | 'in_review' | 'done';
export type StageStateKey = 'backlog' | 'ready' | 'in_progress' | 'internal_review' | 'done';

export interface StageView {
  readonly id: string;
  readonly name: string;
  readonly stateKey: string;
  readonly group: StageGroup;
  readonly colorKey: string | null;
  readonly position: number;
}

export interface StageSetView {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly isDefault: boolean;
  /** The built-in stages (never stored, not editable); names are shown by state label. */
  readonly isBuiltIn: boolean;
  readonly version: number;
  readonly stages: readonly StageView[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface EffectiveStageSetView {
  readonly source: 'work' | 'project' | 'workspace' | 'builtin';
  readonly stageSet: StageSetView;
}

export interface NewStageInput {
  readonly name: string;
  readonly stateKey: StageStateKey;
  readonly colorKey?: string | null;
}

function org(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}
function sets(organizationSlug: string): string {
  return `${org(organizationSlug)}/work/stage-sets`;
}

export async function listStageSets(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly StageSetView[]> {
  const { data } = await client.request<{ stageSets: readonly StageSetView[] }>({
    path: sets(organizationSlug),
  });
  return data.stageSets;
}

export async function createStageSet(
  client: ApiClient,
  organizationSlug: string,
  body: {
    readonly name: string;
    readonly projectId?: string;
    readonly isDefault?: boolean;
    readonly stages?: readonly NewStageInput[];
  },
): Promise<StageSetView> {
  const { data } = await client.request<StageSetView>({
    method: 'POST',
    path: sets(organizationSlug),
    body,
  });
  return data;
}

export async function updateStageSet(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
  body: { readonly version: number; readonly name?: string; readonly isDefault?: boolean },
): Promise<StageSetView> {
  const { data } = await client.request<StageSetView>({
    method: 'PATCH',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}`,
    body,
  });
  return data;
}

export async function deleteStageSet(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}`,
  });
}

export async function addStage(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
  body: NewStageInput & { readonly position?: number },
): Promise<StageSetView> {
  const { data } = await client.request<StageSetView>({
    method: 'POST',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}/stages`,
    body,
  });
  return data;
}

export async function updateStage(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
  stageId: string,
  body: {
    readonly name?: string;
    readonly stateKey?: StageStateKey;
    readonly colorKey?: string | null;
  },
): Promise<StageSetView> {
  const { data } = await client.request<StageSetView>({
    method: 'PATCH',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}/stages/${encodeURIComponent(stageId)}`,
    body,
  });
  return data;
}

/** Delete a stage; its works move to `moveToStageId` (same state) or the first stage of their state. */
export async function deleteStage(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
  stageId: string,
  moveToStageId?: string,
): Promise<StageSetView> {
  const suffix = moveToStageId ? `?moveToStageId=${encodeURIComponent(moveToStageId)}` : '';
  const { data } = await client.request<StageSetView>({
    method: 'DELETE',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}/stages/${encodeURIComponent(stageId)}${suffix}`,
  });
  return data;
}

export async function reorderStages(
  client: ApiClient,
  organizationSlug: string,
  stageSetId: string,
  stageIds: readonly string[],
): Promise<StageSetView> {
  const { data } = await client.request<StageSetView>({
    method: 'PUT',
    path: `${sets(organizationSlug)}/${encodeURIComponent(stageSetId)}/stages/order`,
    body: { stageIds },
  });
  return data;
}

/** The stages a project uses (its board columns) and where they come from. */
export async function fetchProjectStageSet(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<EffectiveStageSetView> {
  const { data } = await client.request<EffectiveStageSetView>({
    path: `${org(organizationSlug)}/projects/${encodeURIComponent(projectId)}/stage-set`,
  });
  return data;
}

/** Point a project at a set; `null` = the workspace's stages. */
export async function setProjectStageSet(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  stageSetId: string | null,
): Promise<EffectiveStageSetView> {
  const { data } = await client.request<EffectiveStageSetView>({
    method: 'PUT',
    path: `${org(organizationSlug)}/projects/${encodeURIComponent(projectId)}/stage-set`,
    body: { stageSetId },
  });
  return data;
}

/** Move a work to a stage. A stage in another state needs the same facts as that state move. */
export async function moveWorkToStage(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  body: {
    readonly stageId: string;
    readonly version: number;
    readonly facts?: Readonly<Record<string, unknown>>;
  },
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'PUT',
    path: `${org(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/stage`,
    body,
  });
  return data;
}

/** Give one work its own stage set; `null` = its project's. */
export async function setWorkStageSet(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  body: { readonly stageSetId: string | null; readonly version: number },
): Promise<WorkItemSummary> {
  const { data } = await client.request<WorkItemSummary>({
    method: 'PUT',
    path: `${org(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/stage-set`,
    body,
  });
  return data;
}
