import type { ApiClient } from './client';

/**
 * Skill directory search (module 14, x194).
 *
 * This module wraps the skill-search API: find the organization's members who declare one or more
 * skill tags, with an optional minimum level. The one exported response shape is
 * {@link SkillSearchResult}, paired Exact with the API's `SkillSearchView` in the contracts gate.
 * `organizationId` is absent on both sides — the wire projection never echoes the tenant id.
 *
 * A blank query returns an empty result rather than the whole directory (the API enforces this too),
 * so this wrapper does not call the endpoint when no skill is selected.
 */

/** The three proficiency rungs. Mirrors the API's `PersonSkillLevel`. */
export type SkillLevel = 'basic' | 'proficient' | 'expert';

/** One directory hit — paired Exact with the API's `SkillSearchView`. */
export interface SkillSearchResult {
  readonly membershipId: string;
  readonly role: string;
  readonly status: 'invited' | 'active' | 'suspended' | 'offboarded';
  readonly matched: readonly { readonly label: string; readonly level: SkillLevel }[];
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/skills/search`;
}

/**
 * Search the member directory by skill. Pass one or more skill labels and an optional minimum level.
 * With no labels this returns an empty array without touching the network.
 */
export async function searchSkills(
  client: ApiClient,
  organizationSlug: string,
  skills: readonly string[],
  options: { readonly minLevel?: SkillLevel; readonly limit?: number } = {},
): Promise<readonly SkillSearchResult[]> {
  const labels = skills.map((s) => s.trim()).filter((s) => s !== '');
  if (labels.length === 0) return [];

  const params = new URLSearchParams();
  for (const label of labels) params.append('skill', label);
  if (options.minLevel) params.set('level', options.minLevel);
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  const { data } = await client.request<{ results: readonly SkillSearchResult[] }>({
    path: `${base(organizationSlug)}?${params.toString()}`,
  });
  return data.results;
}
