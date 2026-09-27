import type { ApiClient } from './client';

/**
 * Org glossary of terms (x263) — a studio's shared vocabulary. Search/list the glossary, add a term,
 * edit it, and remove it. Reads are behind the API's `doc.read`; writes behind `doc.write` (the
 * doc-authoring capability). This module wraps only what the glossary screen consumes, the discipline
 * the contracts gate enforces on this folder.
 */

/**
 * One glossary term — paired Exact with the API's `GlossaryTermView` in the contracts gate
 * (`e2e/contracts/api-web-shapes.ts`). `organizationId` is absent on both sides: the wire projection
 * never echoes the tenant id.
 */
export interface GlossaryTermSummary {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant. */
  readonly updatedAt: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/glossary/terms`;
}

/** List the studio's glossary, alphabetically. `query` filters to a term prefix. */
export async function listGlossaryTerms(
  client: ApiClient,
  organizationSlug: string,
  query?: string,
): Promise<readonly GlossaryTermSummary[]> {
  const suffix = query && query !== '' ? `?q=${encodeURIComponent(query)}` : '';
  const { data } = await client.request<{ terms: readonly GlossaryTermSummary[] }>({
    path: `${base(organizationSlug)}${suffix}`,
  });
  return data.terms;
}

/** Add a term. A duplicate term (case-insensitive) is a 409 from the API. */
export async function createGlossaryTerm(
  client: ApiClient,
  organizationSlug: string,
  input: { term: string; definition: string },
): Promise<GlossaryTermSummary> {
  const { data } = await client.request<GlossaryTermSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Edit a term's text and/or definition. */
export async function updateGlossaryTerm(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  input: { term?: string; definition?: string },
): Promise<GlossaryTermSummary> {
  const { data } = await client.request<GlossaryTermSummary>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
    body: input,
  });
  return data;
}

/** Remove a term. */
export async function deleteGlossaryTerm(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}
