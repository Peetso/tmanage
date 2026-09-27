import type { ApiClient } from './client';

/**
 * Work item labels / tags (module 7, x233).
 *
 * This module wraps the work-labels API: list and define org-scoped label definitions, and
 * assign / list / remove labels on a work item. Two response shapes are exported and paired in the
 * contracts gate — {@link WorkLabel} (a definition, Exact with the API's `WorkLabelView`) and
 * {@link ItemLabel} (a label on an item, Exact with `ItemLabelView`). `organizationId` is absent on
 * both, as on every wire projection.
 */

/** The fixed palette a label's colour is drawn from. Mirrors the API's `WORK_LABEL_COLORS`. */
export const WORK_LABEL_COLORS = [
  'gray',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export type WorkLabelColor = (typeof WORK_LABEL_COLORS)[number];

/** One label definition — paired Exact with the API's `WorkLabelView`. */
export interface WorkLabel {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

/** One label assigned to a work item — paired Exact with the API's `ItemLabelView`. */
export interface ItemLabel {
  readonly id: string;
  readonly workItemId: string;
  readonly labelId: string;
  readonly name: string;
  readonly color: string;
  readonly createdAt: string;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface DefineWorkLabelInput {
  readonly name: string;
  readonly color: WorkLabelColor;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's label definitions, name-ascending. */
export async function listWorkLabels(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkLabel[]> {
  const { data } = await client.request<{ labels: readonly WorkLabel[] }>({
    path: `${orgBase(organizationSlug)}/work/labels`,
  });
  return data.labels;
}

/** Define a label. */
export async function defineWorkLabel(
  client: ApiClient,
  organizationSlug: string,
  input: DefineWorkLabelInput,
): Promise<WorkLabel> {
  const { data } = await client.request<WorkLabel>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/work/labels`,
    body: input,
  });
  return data;
}

/** List the labels assigned to a work item. */
export async function listItemLabels(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly ItemLabel[]> {
  const { data } = await client.request<{ labels: readonly ItemLabel[] }>({
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/labels`,
  });
  return data.labels;
}

/** Tag a work item with a label (idempotent). */
export async function assignItemLabel(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  labelId: string,
): Promise<ItemLabel> {
  const { data } = await client.request<ItemLabel>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/labels`,
    body: { labelId },
  });
  return data;
}

/** Untag a work item. */
export async function removeItemLabel(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  labelId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/labels/${encodeURIComponent(labelId)}`,
  });
}
