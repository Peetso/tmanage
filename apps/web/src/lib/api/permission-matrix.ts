import type {
  Capability,
  EffectivePermissionsView,
  MatrixAction,
  MatrixArea,
  MatrixRow,
  PermissionOverrides,
} from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * platform-admin v2 · PA-01 — the organization-side permission routes (SPEC §3.3). The screens
 * that use them (D7 role matrix, D8 member overrides + preview) arrive in PA-04; the shapes are
 * paired with the API in `e2e/contracts/api-web-shapes.ts`.
 *
 * - `GET admin/roles/matrix` — every role as a capability set plus the matrix layout (`org.manage`).
 * - `GET|PUT people/:membershipId/permissions/overrides` — one member's overrides (`roles.assign`).
 * - `GET people/:membershipId/effective-permissions?projectId=` — "what can this person do".
 * - `GET me` — the caller's role, effective capabilities, overrides and support session.
 */

export interface MatrixRole {
  readonly id: string;
  readonly name: string;
  readonly kind: 'internal' | 'client';
  readonly builtIn: boolean;
  readonly capabilities: readonly Capability[];
}

export interface RolesMatrix {
  readonly areas: readonly MatrixArea[];
  readonly actions: readonly MatrixAction[];
  readonly matrix: Readonly<Record<MatrixArea, MatrixRow>>;
  readonly roles: readonly MatrixRole[];
}

export interface MemberOverride {
  readonly id: string;
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly live: boolean;
}

export interface MemberOverrides {
  readonly membershipId: string;
  readonly role: string;
  readonly editable: boolean;
  readonly overrides: readonly MemberOverride[];
}

export interface MemberOverridesChange extends MemberOverrides {
  readonly added: number;
  readonly removed: number;
}

export interface MemberOverrideInput {
  readonly capability: Capability;
  readonly effect: 'allow' | 'deny';
  readonly reason?: string | null;
  readonly expiresAt?: string | null;
}

export interface EffectivePermissions {
  readonly membershipId: string;
  readonly role: string;
  readonly projectId: string | null;
  readonly overrides: PermissionOverrides;
  readonly permissions: EffectivePermissionsView;
}

export interface OrganizationMe {
  readonly membershipId: string;
  readonly userId: string;
  readonly kind: 'internal' | 'client' | 'service';
  readonly role: string;
  readonly capabilities: readonly Capability[];
  readonly overrides: PermissionOverrides;
  readonly supportSession: { readonly id: string; readonly expiresAt: string | null } | null;
}

function org(slug: string): string {
  return `/v1/organizations/${encodeURIComponent(slug)}`;
}

export async function readRolesMatrix(client: ApiClient, slug: string): Promise<RolesMatrix> {
  const { data } = await client.request<RolesMatrix>({ path: `${org(slug)}/admin/roles/matrix` });
  return data;
}

export async function readMemberOverrides(
  client: ApiClient,
  slug: string,
  membershipId: string,
): Promise<MemberOverrides> {
  const { data } = await client.request<MemberOverrides>({
    path: `${org(slug)}/people/${encodeURIComponent(membershipId)}/permissions/overrides`,
  });
  return data;
}

export async function replaceMemberOverrides(
  client: ApiClient,
  slug: string,
  membershipId: string,
  overrides: readonly MemberOverrideInput[],
): Promise<MemberOverridesChange> {
  const { data } = await client.request<MemberOverridesChange>({
    method: 'PUT',
    path: `${org(slug)}/people/${encodeURIComponent(membershipId)}/permissions/overrides`,
    body: { overrides },
  });
  return data;
}

export async function readEffectivePermissions(
  client: ApiClient,
  slug: string,
  membershipId: string,
  projectId?: string,
): Promise<EffectivePermissions> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<EffectivePermissions>({
    path: `${org(slug)}/people/${encodeURIComponent(membershipId)}/effective-permissions${query}`,
  });
  return data;
}

export async function readOrganizationMe(client: ApiClient, slug: string): Promise<OrganizationMe> {
  const { data } = await client.request<OrganizationMe>({ path: `${org(slug)}/me` });
  return data;
}
