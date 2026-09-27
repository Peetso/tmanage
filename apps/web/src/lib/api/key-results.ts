import type { ApiClient } from './client';

/**
 * The key-results endpoints — PROJ / module 8 (x207), gated on `project.manage` (create, update) /
 * `work.read` (list). Nested under an objective: every path names the objective the key results belong
 * to, tenant-scoped by the API, which derives the objective's project for the relation gate.
 *
 * - **A key result is created and edited, never deleted (this slice).** `POST …/objectives/:id/key-results`
 *   records a measurable target; `PATCH …/objectives/:id/key-results/:keyResultId` revises its body —
 *   the inline progress edit.
 * - **The list is one objective's.** `GET …/objectives/:id/key-results` lists an objective's key results
 *   in creation order, tenant-scoped by the API.
 * - **Progress is the API's.** `progressPercent` is computed server-side from `currentValue / targetValue`
 *   (bounded 0–100, div-by-zero safe); the client renders it, it never recomputes it.
 */

export interface KeyResult {
  readonly id: string;
  readonly objectiveId: string;
  readonly title: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit: string;
  /** An integer 0–100, computed by the API. */
  readonly progressPercent: number;
  readonly createdBy: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
  /** An ISO-8601 instant. */
  readonly updatedAt: string;
}

export interface CreateKeyResultInput {
  readonly title: string;
  readonly targetValue: number;
  readonly currentValue?: number;
  readonly unit: string;
}

export interface UpdateKeyResultInput {
  readonly title?: string;
  readonly targetValue?: number;
  readonly currentValue?: number;
  readonly unit?: string;
}

export async function listKeyResults(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  query: { readonly limit?: number } = {},
): Promise<readonly KeyResult[]> {
  const parameters = new URLSearchParams();
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const suffix = parameters.toString() === '' ? '' : `?${parameters.toString()}`;

  const { data } = await client.request<{ keyResults: readonly KeyResult[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/key-results${suffix}`,
  });
  return data.keyResults;
}

export async function createKeyResult(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  input: CreateKeyResultInput,
): Promise<KeyResult> {
  const { data } = await client.request<KeyResult>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/key-results`,
    body: input,
  });
  return data;
}

export async function updateKeyResult(
  client: ApiClient,
  organizationSlug: string,
  objectiveId: string,
  keyResultId: string,
  input: UpdateKeyResultInput,
): Promise<KeyResult> {
  const { data } = await client.request<KeyResult>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/objectives/${encodeURIComponent(objectiveId)}/key-results/${encodeURIComponent(keyResultId)}`,
    body: input,
  });
  return data;
}
