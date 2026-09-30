import type { ApiClient } from './client';

/**
 * Person certifications (module 14, x326).
 *
 * This module wraps the person-certifications API: list a person's certifications, record one, and
 * remove one. The one exported response shape is {@link PersonCertificationSummary}, paired Exact
 * with the API's `PersonCertificationView` in the contracts gate. `organizationId` is absent on both
 * sides — the wire projection never echoes the tenant id. `expired` is computed by the API read-side.
 */

/** One person certification — paired Exact with the API's `PersonCertificationView`. */
export interface PersonCertificationSummary {
  readonly id: string;
  readonly personUserId: string;
  readonly name: string;
  readonly issuer: string;
  /** The day it was issued, `'YYYY-MM-DD'`. */
  readonly issuedOn: string;
  /** The day it expires, `'YYYY-MM-DD'`, or null when the credential does not expire. */
  readonly expiresOn: string | null;
  /** True when the credential has lapsed (computed by the API against today). */
  readonly expired: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The fields a record request sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface AddPersonCertificationInput {
  readonly name: string;
  readonly issuer: string;
  readonly issuedOn: string;
  readonly expiresOn?: string | null;
}

function base(organizationSlug: string, userId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    userId,
  )}/certifications`;
}

/** List a person's certifications, newest issue first. */
export async function listPersonCertifications(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
): Promise<readonly PersonCertificationSummary[]> {
  const { data } = await client.request<{ certifications: readonly PersonCertificationSummary[] }>({
    path: base(organizationSlug, userId),
  });
  return data.certifications;
}

/** Record a certification for a person. */
export async function addPersonCertification(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  input: AddPersonCertificationInput,
): Promise<PersonCertificationSummary> {
  const { data } = await client.request<PersonCertificationSummary>({
    method: 'POST',
    path: base(organizationSlug, userId),
    body: input,
  });
  return data;
}

/** Remove a person's certification. Idempotent on the API — a repeated delete is still a success. */
export async function removePersonCertification(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  certificationId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, userId)}/${encodeURIComponent(certificationId)}`,
  });
}
