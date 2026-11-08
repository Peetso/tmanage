import type { ApiClient } from './client';

/**
 * 54-16 — SCIM 2.0 provisioning keys, the owner's half (`…/security/scim`). The key's secret is in
 * the create answer only; the list carries a display prefix and never the secret or its hash.
 */

/** Mirrors the API's `ScimKeyView`. */
export interface ScimKeyView {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Mirrors the API's `ScimSettingsView`. */
export interface ScimSettingsView {
  readonly available: boolean;
  readonly baseUrl: string;
  readonly keys: readonly ScimKeyView[];
}

/** Mirrors the API's `ScimKeyCreatedView`. */
export interface ScimKeyCreatedView {
  readonly key: ScimKeyView;
  readonly secret: string;
}

function path(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/security/scim`;
}

export async function readScimSettings(
  client: ApiClient,
  organizationSlug: string,
): Promise<ScimSettingsView> {
  const { data } = await client.request<ScimSettingsView>({ path: path(organizationSlug) });
  return data;
}

export async function createScimKey(
  client: ApiClient,
  organizationSlug: string,
  name: string,
): Promise<ScimKeyCreatedView> {
  const { data } = await client.request<ScimKeyCreatedView>({
    method: 'POST',
    path: `${path(organizationSlug)}/keys`,
    body: { name: name.trim() },
  });
  return data;
}

export async function revokeScimKey(
  client: ApiClient,
  organizationSlug: string,
  keyId: string,
): Promise<ScimSettingsView> {
  const { data } = await client.request<ScimSettingsView>({
    method: 'DELETE',
    path: `${path(organizationSlug)}/keys/${encodeURIComponent(keyId)}`,
  });
  return data;
}
