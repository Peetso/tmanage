import type { ApiClient } from './client';
import type { WorkFormFieldType } from './work-forms';

/**
 * 52-20 — the anonymous door of a published work form, as the public page `/f/<slug>` uses it.
 * No session: both calls go with `authentication: 'none'`. The visitor never sees an id, a project
 * or an organization — only the title and the fields under opaque keys (`f1`, `f2`, …).
 */

/** One field as a visitor sees it. Mirrors the API's `PublicFormField`. */
export interface PublicFormField {
  readonly key: string;
  readonly label: string;
  readonly type: WorkFormFieldType;
  readonly required: boolean;
  readonly maxLength?: number;
}

/** `GET /v1/public/forms/:slug`. Mirrors the API's `PublicFormDefinition`. */
export interface PublicFormDefinition {
  readonly title: string;
  readonly fields: readonly PublicFormField[];
}

/** A held submission's challenge. Mirrors the API's `ChallengeView`. */
export interface PublicChallengeView {
  readonly kind: 'email_code' | 'pow' | 'turnstile';
  readonly challengeId: string;
  readonly resendAfterSeconds: number;
  readonly salt?: string;
  readonly bits?: number;
}

/** What a submission POST answers: stored (`reference`) or held (`challenge`). */
export type PublicSubmitResult =
  { readonly reference: string } | { readonly challenge: PublicChallengeView };

/** The body a submission sends. Request-side (suffix `Input`). */
export type PublicSubmitInput = Readonly<Record<string, unknown>> & {
  readonly values: Readonly<Record<string, string | number | boolean>>;
};

function path(slug: string): string {
  return `/v1/public/forms/${encodeURIComponent(slug)}`;
}

export async function getPublicForm(
  client: ApiClient,
  slug: string,
): Promise<PublicFormDefinition> {
  const { data } = await client.request<PublicFormDefinition>({
    path: path(slug),
    authentication: 'none',
  });
  return data;
}

export async function submitPublicForm(
  client: ApiClient,
  slug: string,
  input: PublicSubmitInput,
): Promise<PublicSubmitResult> {
  const { data } = await client.request<PublicSubmitResult>({
    method: 'POST',
    path: `${path(slug)}/submissions`,
    body: input,
    authentication: 'none',
  });
  return data;
}
