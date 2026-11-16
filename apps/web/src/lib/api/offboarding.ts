import type { ApiClient } from './client';

/**
 * Member offboarding — ADM-12/13 (x121), behind `member.offboard`.
 *
 * Tenant-scoped like `members.ts`: the slug is in the path, the API resolves it against a
 * membership row before the handler runs, and the route needs `member.offboard`, which no client
 * role holds — so the portal cannot reach either endpoint. Both name the membership by id in the
 * path and the API resolves it tenant-scoped before any write, so an unknown or cross-tenant id is
 * a 404, not a 500.
 */

/**
 * The access and work a member holds, as the impact preview reads it. Paired `Exact` with the
 * API's `MemberOffboardingImpactView` in the contracts gate (`e2e/contracts/api-web-shapes.ts`):
 * rename or retype a field on either side and `pnpm contracts:check` fails.
 */
export interface OffboardingImpactView {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly projectMembershipCount: number;
  readonly ownedWorkItemCount: number;
  readonly offboardable: boolean;
  /** 51-17. The company storage connections this person holds (hand them over first). */
  readonly storageConnections: readonly ('google_drive' | 'onedrive')[];
}

/** The confirmation an offboard returns. Paired `Exact` with the API's `OffboardedMemberView`. */
export interface OffboardedMember {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  /** 51-17. The storage connections still on this person's account: hand them over now. */
  readonly storageHandoverRequired: readonly ('google_drive' | 'onedrive')[];
}

/** ADM-12 — the read-only access-impact preview for one membership. */
export async function getOffboardingImpact(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<OffboardingImpactView> {
  const { data } = await client.request<OffboardingImpactView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members/${encodeURIComponent(membershipId)}/offboarding-impact`,
  });
  return data;
}

/** ADM-13 — offboard a member. The body carries no fields: the membership is named in the path. */
export async function offboardMember(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<OffboardedMember> {
  const { data } = await client.request<OffboardedMember>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members/${encodeURIComponent(membershipId)}/offboard`,
  });
  return data;
}
