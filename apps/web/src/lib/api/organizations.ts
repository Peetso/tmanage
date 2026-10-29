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
  /** H1: a custom role's own name; present only when `role` is a custom role id. */
  readonly roleName?: string;
  /** H1: the custom role's loaded capabilities; present only when `role` is a custom role id. */
  readonly capabilities?: readonly string[];
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

// ── A11: the Organization settings card — name and logo ─────────────────────────────────────

/** `GET …/profile` and the name/logo writes. Paired Exact with the API's `OrganizationProfileView`. */
export interface OrganizationProfileView {
  readonly name: string;
  readonly logoFileId: string | null;
}

function organizationPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

export async function readOrganizationProfile(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationProfileView> {
  const { data } = await client.request<OrganizationProfileView>({
    path: `${organizationPath(organizationSlug)}/profile`,
  });
  return data;
}

export async function renameOrganization(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<OrganizationProfileView> {
  const { data } = await client.request<OrganizationProfileView>({
    method: 'PATCH',
    path: organizationPath(organizationSlug),
    body: { name },
  });
  return data;
}

export async function setOrganizationLogo(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<OrganizationProfileView> {
  const { data } = await client.request<OrganizationProfileView>({
    method: 'PUT',
    path: `${organizationPath(organizationSlug)}/logo`,
    body: { fileId },
  });
  return data;
}

export async function removeOrganizationLogo(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationProfileView> {
  const { data } = await client.request<OrganizationProfileView>({
    method: 'DELETE',
    path: `${organizationPath(organizationSlug)}/logo`,
  });
  return data;
}

/** The logo types the card offers ("PNG or SVG"). */
export const LOGO_ACCEPT = '.png,.svg,image/png,image/svg+xml';

/** The declared media type for a logo file, or `null` when it is not a PNG or SVG. */
export function logoMimeType(file: {
  readonly name: string;
  readonly type: string;
}): string | null {
  const reported = file.type.trim().toLowerCase();
  if (reported === 'image/png' || reported === 'image/svg+xml') return reported;
  const name = file.name.toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return null;
}

/**
 * Upload a logo through the ordinary upload pipeline (purpose `org_logo`) and answer the new file
 * asset's id. The pipeline files every upload under a project, so the logo is filed under the
 * organization's first project; the logo itself belongs to the organization row, not the project.
 */
export async function uploadOrganizationLogo(
  client: ApiClient,
  organizationSlug: string,
  file: Blob & { readonly name: string; readonly type: string; readonly size: number },
  deps: {
    readonly fetch?: typeof globalThis.fetch;
    readonly newKey?: () => string;
  } = {},
): Promise<string> {
  const mimeType = logoMimeType(file);
  if (mimeType === null) throw new Error('logo_type');
  const base = organizationPath(organizationSlug);
  const { data: projects } = await client.request<{ projects: readonly { id: string }[] }>({
    path: `${base}/projects?limit=1`,
  });
  const projectId = projects.projects[0]?.id;
  if (!projectId) throw new Error('logo_no_project');

  const key =
    deps.newKey?.() ??
    `logo-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`}`;
  const { data: session } = await client.request<{
    readonly id: string;
    readonly partSizeBytes: number;
    readonly uploadUrls: readonly { readonly partNumber: number; readonly url: string }[];
  }>({
    method: 'POST',
    path: `${base}/upload-sessions`,
    headers: { 'idempotency-key': key },
    body: { projectId, fileName: file.name, mimeType, sizeBytes: file.size, purpose: 'org_logo' },
  });

  const send = deps.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const parts: { partNumber: number; etag: string }[] = [];
    for (const target of [...session.uploadUrls].sort((a, b) => a.partNumber - b.partNumber)) {
      const start = (target.partNumber - 1) * session.partSizeBytes;
      const response = await send(target.url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: file.slice(start, start + session.partSizeBytes),
        credentials: 'omit',
      });
      const etag = response.headers.get('etag');
      if (!response.ok || !etag) throw new Error('logo_upload');
      parts.push({ partNumber: target.partNumber, etag });
    }
    const { data: asset } = await client.request<{ readonly id: string }>({
      method: 'POST',
      path: `${base}/upload-sessions/${encodeURIComponent(session.id)}/complete`,
      body: { parts },
    });
    return asset.id;
  } catch (error) {
    await client
      .request<unknown>({
        method: 'POST',
        path: `${base}/upload-sessions/${encodeURIComponent(session.id)}/cancel`,
      })
      .catch(() => undefined);
    throw error;
  }
}

// ---- platform-admin v2 · PA-05 ----

/**
 * The live Support session in this organization (A8 banner). `null` when no TManage support is
 * inside it. Paired with the API's `OrganizationSupportSessionView`.
 */
export interface OrganizationSupportSessionView {
  readonly id: string;
  readonly expiresAt: string;
  readonly adminEmail: string;
  readonly startedAt: string;
  readonly actionsCount: number;
}

export async function fetchOrganizationSupportSession(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationSupportSessionView | null> {
  const { data } = await client.request<{
    readonly supportSession: OrganizationSupportSessionView | null;
  }>({ path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/support-session` });
  return data.supportSession;
}
