import type { ApiClient } from './client';

/**
 * PROJ / module 8 (x310) — custom fields for projects. An organization defines fields (a key, a
 * display name, a type, and for a `select` its options) behind `org.manage`, and sets a value per
 * project and reads a project's resolved field+value map behind `project.manage`. A caller without
 * the capability gets the ordinary refusal the shared client turns into an error.
 *
 * The tenant is the slug in the path resolved against the caller's membership; `organizationId` is
 * never a value this client supplies. Paired with the API projections
 * (`ProjectCustomFieldsService.ProjectCustomFieldDefinitionView` / `…ValueView`) so the shapes cannot
 * drift.
 */

/** The value type a field declares. Paired with the API enum. */
export type ProjectCustomFieldType = 'text' | 'number' | 'select';

/** A field definition, as the definitions surface returns it. */
export interface ProjectCustomFieldDefinition {
  readonly fieldKey: string;
  readonly name: string;
  readonly fieldType: ProjectCustomFieldType;
  readonly options: readonly string[];
}

/** One entry in a project's resolved field+value map. */
export interface ProjectCustomFieldValue {
  readonly fieldKey: string;
  readonly name: string;
  readonly fieldType: ProjectCustomFieldType;
  readonly options: readonly string[];
  readonly value: string | null;
}

function definitionsPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/custom-fields`;
}

function valuesPath(organizationSlug: string, projectId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(
    projectId,
  )}/custom-fields`;
}

/** List the organization's field definitions (behind `org.manage`). */
export async function listFieldDefinitions(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ProjectCustomFieldDefinition[]> {
  const { data } = await client.request<{ definitions: readonly ProjectCustomFieldDefinition[] }>({
    path: definitionsPath(organizationSlug),
  });
  return data.definitions;
}

/** Define a project custom field (behind `org.manage`). */
export async function defineField(
  client: ApiClient,
  organizationSlug: string,
  input: {
    key: string;
    name: string;
    type: ProjectCustomFieldType;
    options?: readonly string[];
  },
): Promise<ProjectCustomFieldDefinition> {
  const { data } = await client.request<ProjectCustomFieldDefinition>({
    method: 'POST',
    path: definitionsPath(organizationSlug),
    body: {
      key: input.key,
      name: input.name,
      type: input.type,
      ...(input.options === undefined ? {} : { options: input.options }),
    },
  });
  return data;
}

/** Delete a field definition by key (behind `org.manage`). */
export async function deleteField(
  client: ApiClient,
  organizationSlug: string,
  fieldKey: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${definitionsPath(organizationSlug)}/${encodeURIComponent(fieldKey)}`,
  });
}

/** Read a project's resolved field+value map (behind `project.manage`). */
export async function listProjectCustomFields(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectCustomFieldValue[]> {
  const { data } = await client.request<{ fields: readonly ProjectCustomFieldValue[] }>({
    path: valuesPath(organizationSlug, projectId),
  });
  return data.fields;
}

/** Set a project's value for a field, idempotently (behind `project.manage`). */
export async function setProjectCustomFieldValue(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  fieldKey: string,
  value: string,
): Promise<ProjectCustomFieldValue> {
  const { data } = await client.request<ProjectCustomFieldValue>({
    method: 'PUT',
    path: `${valuesPath(organizationSlug, projectId)}/${encodeURIComponent(fieldKey)}`,
    body: { value },
  });
  return data;
}
