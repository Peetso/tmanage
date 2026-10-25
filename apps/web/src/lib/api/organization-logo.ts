import type { ApiClient } from './client';

/**
 * C6 — the company logo, held by the organization (no project). The API checks every upload:
 * PNG, JPEG and WebP by their bytes, SVG only after its own sanitiser has removed scripts, event
 * handlers and external references. Paired with the API's `OrganizationLogoView`.
 */
export interface OrganizationLogoView {
  readonly logo: {
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly version: number;
    readonly updatedAt: string;
  } | null;
}

/** The types the card offers. */
export const LOGO_IMAGE_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml';

/** The API's cap (512 KiB), checked here first so a too-big file is refused without a round trip. */
export const LOGO_IMAGE_MAX_BYTES = 512 * 1024;

const BY_TYPE = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
const BY_EXTENSION: Readonly<Record<string, (typeof BY_TYPE)[number]>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** The declared media type for a logo file, or `null` when it is not one the card takes. */
export function logoImageMimeType(file: {
  readonly name: string;
  readonly type: string;
}): string | null {
  const reported = file.type.trim().toLowerCase();
  if ((BY_TYPE as readonly string[]).includes(reported)) return reported;
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  return BY_EXTENSION[extension] ?? null;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/logo`;
}

/** Where the logo image is served; the version busts the five-minute cache after a change. */
export function logoImageUrl(baseUrl: string, organizationSlug: string, version: number): string {
  return `${baseUrl}${path(organizationSlug)}/image?v=${version}`;
}

export async function readOrganizationLogo(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationLogoView> {
  const { data } = await client.request<OrganizationLogoView>({ path: path(organizationSlug) });
  return data;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Upload a logo. Throws `logo_type` / `logo_size` before any request for a file the API would refuse. */
export async function uploadOrganizationLogoImage(
  client: ApiClient,
  organizationSlug: string,
  file: Blob & { readonly name: string; readonly type: string },
): Promise<OrganizationLogoView> {
  const mimeType = logoImageMimeType(file);
  if (mimeType === null) throw new Error('logo_type');
  if (file.size > LOGO_IMAGE_MAX_BYTES) throw new Error('logo_size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { data } = await client.request<OrganizationLogoView>({
    method: 'PUT',
    path: `${path(organizationSlug)}/image`,
    body: { mimeType, dataBase64: toBase64(bytes) },
  });
  return data;
}

export async function removeOrganizationLogoImage(
  client: ApiClient,
  organizationSlug: string,
): Promise<OrganizationLogoView> {
  const { data } = await client.request<OrganizationLogoView>({
    method: 'DELETE',
    path: `${path(organizationSlug)}/image`,
  });
  return data;
}
