import type { ApiClient } from './client';

/**
 * People member skills (module 14, x172).
 *
 * This module wraps the person-skills API: list a member's skills, add one, and remove one. The one
 * exported response shape is {@link PersonSkillSummary}, paired Exact with the API's
 * `PersonSkillView` in the contracts gate. `organizationId` is absent on both sides — the wire
 * projection never echoes the tenant id.
 */

/** The three proficiency rungs a skill can carry. Mirrors the API's `PersonSkillLevel`. */
export type PersonSkillLevel = 'basic' | 'proficient' | 'expert';

/** One member skill — paired Exact with the API's `PersonSkillView`. */
export interface PersonSkillSummary {
  readonly id: string;
  readonly membershipId: string;
  readonly label: string;
  readonly level: PersonSkillLevel;
  readonly createdAt: string;
}

/** The fields an add sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface AddPersonSkillInput {
  readonly label: string;
  readonly level: PersonSkillLevel;
}

function base(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    membershipId,
  )}/skills`;
}

/** List a member's skills, label-ascending. */
export async function listPersonSkills(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<readonly PersonSkillSummary[]> {
  const { data } = await client.request<{ skills: readonly PersonSkillSummary[] }>({
    path: base(organizationSlug, membershipId),
  });
  return data.skills;
}

/** Add a skill to a member. */
export async function addPersonSkill(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  input: AddPersonSkillInput,
): Promise<PersonSkillSummary> {
  const { data } = await client.request<PersonSkillSummary>({
    method: 'POST',
    path: base(organizationSlug, membershipId),
    body: input,
  });
  return data;
}

/** Remove a member's skill. */
export async function removePersonSkill(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  skillId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, membershipId)}/${encodeURIComponent(skillId)}`,
  });
}
