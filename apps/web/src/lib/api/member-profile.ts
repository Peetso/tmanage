import type { ApiClient } from './client';

/**
 * The member profile edit endpoint — x216, the writable counterpart to x169's read-only profile.
 * Behind `org.manage` on the server (the existing people/admin capability); a caller without it gets
 * the ordinary 403 the shared client turns into an error, and a cross-tenant or unknown membership
 * id gets a 404.
 *
 * Distinct from x169's `PersonProfileView` read shape: this carries only the four tenant-local,
 * editable fields — never `displayName`, which is GLOBAL on the users table and is why x192 was
 * blocked. Hand-written for the boundary reason `errors.ts` gives, and paired with the API
 * projection in the `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the
 * slug in the path resolved against the caller's membership, never a value the caller supplies.
 */

/**
 * One member's tenant-local profile. `membershipId` identifies the member within the studio; the
 * four fields are the editable metadata, each null when unset. No global identity field is present.
 */
export interface MemberProfileView {
  readonly membershipId: string;
  readonly department: string | null;
  readonly bio: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

/** The editable fields sent on save — a full replacement; a null (or omitted) field clears it. */
export interface MemberProfileInput {
  readonly department: string | null;
  readonly bio: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

function profilePath(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    membershipId,
  )}/profile`;
}

export async function fetchMemberProfile(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<MemberProfileView> {
  const { data } = await client.request<MemberProfileView>({
    path: profilePath(organizationSlug, membershipId),
  });
  return data;
}

export async function saveMemberProfile(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  edit: MemberProfileInput,
): Promise<MemberProfileView> {
  const { data } = await client.request<MemberProfileView>({
    method: 'PUT',
    path: profilePath(organizationSlug, membershipId),
    body: edit,
  });
  return data;
}

// ── The acting member's own profile (t2-b "Profile & preferences") ───────────────────────────────

/**
 * The signed-in member's own profile card: the name and job title they may edit, and the sign-in
 * email they may only read (an admin changes it). Own-membership only — there is no id in the path,
 * so the request cannot name anybody else.
 */
export interface MyProfileView {
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string | null;
}

/** What the profile form sends on save — a full replacement of the two editable fields. */
export interface MyProfileInput {
  readonly displayName: string;
  readonly jobTitle: string | null;
}

function myProfilePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/profile`;
}

export async function fetchMyProfile(
  client: ApiClient,
  organizationSlug: string,
): Promise<MyProfileView> {
  const { data } = await client.request<MyProfileView>({ path: myProfilePath(organizationSlug) });
  return data;
}

export async function saveMyProfile(
  client: ApiClient,
  organizationSlug: string,
  input: MyProfileInput,
): Promise<MyProfileView> {
  const { data } = await client.request<MyProfileView>({
    method: 'PUT',
    path: myProfilePath(organizationSlug),
    body: input,
  });
  return data;
}
