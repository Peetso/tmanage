import type { ApiClient } from './client';

/**
 * Automations & integrations (module 17, x335).
 *
 * This module wraps the automation-template-tags API: list a template's tags, add one, remove one,
 * and filter the organization's templates by a tag. The two exported response shapes are
 * {@link AutomationTemplateTagSummary} (paired Exact with the API's `AutomationTemplateTagView`) and
 * {@link AutomationTaggedTemplateSummary} (paired Exact with the API's `AutomationTaggedTemplateView`).
 */

/**
 * One tag on a template — paired Exact with the API's `AutomationTemplateTagView`. `organizationId` is
 * absent on both sides: the wire projection never echoes the tenant id.
 */
export interface AutomationTemplateTagSummary {
  readonly id: string;
  readonly templateId: string;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * One template in the tag-filter result — paired Exact with the API's `AutomationTaggedTemplateView`.
 * The minimal reference a filtered list renders (`name`) and links to (`id`); `organizationId` is
 * absent on both sides.
 */
export interface AutomationTaggedTemplateSummary {
  readonly id: string;
  readonly name: string;
}

/** The fields an add sends — just the label. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateAutomationTemplateTagInput {
  readonly label: string;
}

function tagsBase(organizationSlug: string, templateId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/templates/${encodeURIComponent(
    templateId,
  )}/tags`;
}

/** List a template's tags, label order (x335). */
export async function listAutomationTemplateTags(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
): Promise<readonly AutomationTemplateTagSummary[]> {
  const { data } = await client.request<{ tags: readonly AutomationTemplateTagSummary[] }>({
    path: tagsBase(organizationSlug, templateId),
  });
  return data.tags;
}

/** Add a tag to a template (x335). A duplicate label is a 409; an empty/over-length label is a 400. */
export async function addAutomationTemplateTag(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  input: CreateAutomationTemplateTagInput,
): Promise<AutomationTemplateTagSummary> {
  const { data } = await client.request<AutomationTemplateTagSummary>({
    method: 'POST',
    path: tagsBase(organizationSlug, templateId),
    body: input,
  });
  return data;
}

/** Remove a tag from a template (x335). Idempotent: a missing tag is still a 204. */
export async function removeAutomationTemplateTag(
  client: ApiClient,
  organizationSlug: string,
  templateId: string,
  tagId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${tagsBase(organizationSlug, templateId)}/${encodeURIComponent(tagId)}`,
  });
}

/** Filter the organization's templates by a tag (x335). An empty tag is the API's 400. */
export async function listTemplatesByTag(
  client: ApiClient,
  organizationSlug: string,
  tag: string,
): Promise<readonly AutomationTaggedTemplateSummary[]> {
  const { data } = await client.request<{ templates: readonly AutomationTaggedTemplateSummary[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/template-tags?tag=${encodeURIComponent(
      tag,
    )}`,
  });
  return data.templates;
}
