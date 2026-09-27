import type { ApiClient } from './client';

/**
 * Work item custom fields (module Work, x306).
 *
 * This module wraps the work custom-fields API: list / define / remove org-scoped field definitions
 * (behind `org.manage`), and read / set a field's value on a work item (behind `work.read` /
 * `work.update`). Two response shapes are exported and paired in the contracts gate —
 * {@link WorkCustomFieldDefinition} (Exact with the API's `WorkCustomFieldDefinitionView`) and
 * {@link WorkCustomFieldValue} (Exact with `WorkCustomFieldValueView`). `organizationId` is absent on
 * both, as on every wire projection.
 */

/** The types a custom field may declare. Mirrors the API's `WORK_ITEM_CUSTOM_FIELD_TYPES`. */
export const WORK_CUSTOM_FIELD_TYPES = ['text', 'number', 'select'] as const;

export type WorkCustomFieldType = (typeof WORK_CUSTOM_FIELD_TYPES)[number];

/** One field definition — paired Exact with the API's `WorkCustomFieldDefinitionView`. */
export interface WorkCustomFieldDefinition {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly fieldType: string;
  readonly options: readonly string[] | null;
  readonly createdAt: string;
}

/** One field resolved against a work item's value — paired Exact with `WorkCustomFieldValueView`. */
export interface WorkCustomFieldValue {
  readonly key: string;
  readonly name: string;
  readonly fieldType: string;
  readonly options: readonly string[] | null;
  readonly value: string | null;
  readonly updatedAt: string | null;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface DefineWorkCustomFieldInput {
  readonly key: string;
  readonly name: string;
  readonly fieldType: WorkCustomFieldType;
  readonly options: readonly string[] | null;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's custom-field definitions, key-ascending. */
export async function listWorkCustomFields(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WorkCustomFieldDefinition[]> {
  const { data } = await client.request<{ fields: readonly WorkCustomFieldDefinition[] }>({
    path: `${orgBase(organizationSlug)}/work/custom-fields`,
  });
  return data.fields;
}

/** Define a custom field. */
export async function defineWorkCustomField(
  client: ApiClient,
  organizationSlug: string,
  input: DefineWorkCustomFieldInput,
): Promise<WorkCustomFieldDefinition> {
  const { data } = await client.request<WorkCustomFieldDefinition>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/work/custom-fields`,
    body: input,
  });
  return data;
}

/** Remove a custom-field definition by key. */
export async function removeWorkCustomField(
  client: ApiClient,
  organizationSlug: string,
  key: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/work/custom-fields/${encodeURIComponent(key)}`,
  });
}

/** Read the field+value map for a work item. */
export async function listItemCustomFields(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly WorkCustomFieldValue[]> {
  const { data } = await client.request<{ fields: readonly WorkCustomFieldValue[] }>({
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/custom-fields`,
  });
  return data.fields;
}

/** Set (or revise) a field's value on a work item. */
export async function setItemCustomFieldValue(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  key: string,
  value: unknown,
): Promise<WorkCustomFieldValue> {
  const { data } = await client.request<WorkCustomFieldValue>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/custom-fields/${encodeURIComponent(key)}`,
    body: { value },
  });
  return data;
}
