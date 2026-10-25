import type { ApiClient } from './client';

/**
 * ADM-01 / BK2 — a member's built-in role, read and changed (A1, "Members and roles").
 *
 * Two routes, both behind `org.manage` and narrowed on the server to an owner or organization
 * admin:
 *
 * - `GET admin/roles/built-in` lists every built-in role with its capabilities and whether **this
 *   caller** may hand it out (`assignable`: only an owner may grant `owner`). The Change role and
 *   Invite member dialogs offer exactly what it calls assignable.
 * - `PATCH members/:userId/role` changes one member's role. `version` is the compare-and-swap
 *   token: a stale one is a 409, and the screen reloads the roster. The organization's last active
 *   owner cannot be demoted (409) — the dialog says so first; the API is the backstop.
 */

export interface BuiltInRole {
  readonly role: string;
  readonly kind: 'internal' | 'client';
  readonly capabilities: readonly string[];
  readonly projectRole: boolean;
  readonly assignable: boolean;
}

export interface MemberRoleChange {
  readonly userId: string;
  readonly membershipId: string;
  readonly previousRole: string;
  readonly role: string;
  readonly status: string;
  readonly version: number;
  readonly changed: boolean;
}

/** The four roles the r-change-role and r-invite frames offer, most-privileged first. */
export const MEMBER_ROLE_CHOICES = ['owner', 'org_admin', 'manager', 'member'] as const;
export type MemberRoleChoice = (typeof MEMBER_ROLE_CHOICES)[number];

export function isMemberRoleChoice(role: string): role is MemberRoleChoice {
  return (MEMBER_ROLE_CHOICES as readonly string[]).includes(role);
}

export async function listBuiltInRoles(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly BuiltInRole[]> {
  const { data } = await client.request<{ roles: readonly BuiltInRole[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/roles/built-in`,
  });
  return Array.isArray(data?.roles) ? data.roles : [];
}

/**
 * F1: a built-in role is sent as `role`; a custom role from Control > Roles as `customRoleId`
 * (the API resolves it tenant-scoped and refuses one that grants more than the caller holds).
 */
export type MemberRoleTarget =
  | { readonly role: string; readonly version?: number }
  | { readonly customRoleId: string; readonly version?: number };

export async function changeMemberRole(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  input: MemberRoleTarget,
): Promise<MemberRoleChange> {
  const body =
    'customRoleId' in input ? { customRoleId: input.customRoleId } : { role: input.role };
  const { data } = await client.request<MemberRoleChange>({
    method: 'PATCH',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members/${encodeURIComponent(userId)}/role`,
    body: input.version === undefined ? body : { ...body, version: input.version },
  });
  return data;
}
