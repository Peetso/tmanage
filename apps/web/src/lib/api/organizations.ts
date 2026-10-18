import type { ApiClient } from './client';

/**
 * The organization endpoints — TEN-001's second half, behind `ID-04` and `ON-01`.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and replaced when
 * `packages/contracts` is generated.
 */

export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  readonly clientOrganizationName: string | null;
  /** True when the platform operator suspended it; its members see the suspended page. */
  readonly suspended?: boolean;
}

/**
 * Every organization this session may act in.
 *
 * An empty array is a real and expected answer — it is what a person sees between signing up
 * and creating their first organization — so the API answers 200 with `[]` rather than 404,
 * and nothing here treats emptiness as a failure.
 */
export async function listOrganizations(
  client: ApiClient,
): Promise<readonly OrganizationSummary[]> {
  const { data } = await client.request<{ organizations: readonly OrganizationSummary[] }>({
    path: '/v1/organizations',
  });
  return data.organizations;
}

export interface CreateOrganizationInput {
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  readonly defaultLocale: string;
  /** `mon-fri`, `sun-thu`, `sat-wed` or `mon-sat`. Stored as the organization's working week. */
  readonly workingWeek?: string;
  /** The starting operating template, from the work type chosen on ON-01. */
  readonly operatingTemplate?: string;
}

export interface CreatedOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly role: string;
}

export async function createOrganization(
  client: ApiClient,
  input: CreateOrganizationInput,
): Promise<CreatedOrganization> {
  const { data } = await client.request<CreatedOrganization>({
    method: 'POST',
    path: '/v1/organizations',
    body: input,
  });
  return data;
}

/** `GET /v1/organizations/address-availability` — ON-02's live "available" tick. */
export interface AddressAvailability {
  readonly slug: string;
  readonly available: boolean;
  readonly reason: 'invalid' | 'taken' | null;
  readonly message: string | null;
}

export async function checkAddressAvailability(
  client: ApiClient,
  slug: string,
  signal?: AbortSignal,
): Promise<AddressAvailability> {
  const { data } = await client.request<AddressAvailability>({
    path: `/v1/organizations/address-availability?slug=${encodeURIComponent(slug)}`,
    ...(signal === undefined ? {} : { signal }),
  });
  return data;
}
