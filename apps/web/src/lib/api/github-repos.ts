import type { ApiClient } from './client';

/**
 * R45 L3 (54-10). The existing GitHub Phase 0 backend, as the project settings screen and the work
 * item use it. Mirrors `apps/api/src/modules/automations/github-hooks.service.ts` (repository
 * webhooks, `org.manage`) and `apps/api/src/modules/work/work-keys.service.ts` (code links,
 * `work.read` / `work.update`). The webhook secret comes back only from link and rotate.
 */

export interface GithubRepoHook {
  readonly id: string;
  readonly connectionId: string;
  readonly repoFullName: string;
  readonly projectIds: readonly string[];
  readonly status: string;
  readonly lastEventAt: string | null;
  readonly createdAt: string;
}

export interface GithubRepoHookSecret extends GithubRepoHook {
  readonly secret: string;
  readonly webhookUrl: string;
}

export interface CodeLink {
  readonly id: string;
  readonly provider: string;
  readonly repo: string;
  /** `branch` | `commit` | `pr`. */
  readonly kind: string;
  readonly externalId: string;
  readonly title: string | null;
  readonly state: string | null;
  readonly url: string;
  readonly actorLogin: string | null;
  readonly updatedAt: string;
}

/** `owner/name`, as the API accepts it. */
export const REPO_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;

function hooks(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations/github/repo-hooks`;
}

export async function listRepoHooks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly GithubRepoHook[]> {
  const { data } = await client.request<{ hooks: readonly GithubRepoHook[] }>({
    path: hooks(organizationSlug),
  });
  return data.hooks;
}

/** The hooks that route into this project. */
export function hooksForProject(
  all: readonly GithubRepoHook[],
  projectId: string,
): readonly GithubRepoHook[] {
  return all.filter((hook) => hook.projectIds.includes(projectId));
}

export async function linkRepo(
  client: ApiClient,
  organizationSlug: string,
  repoFullName: string,
  projectId: string,
): Promise<GithubRepoHookSecret> {
  const { data } = await client.request<GithubRepoHookSecret>({
    method: 'POST',
    path: hooks(organizationSlug),
    body: { repoFullName, projectIds: [projectId] },
  });
  return data;
}

export async function unlinkRepo(
  client: ApiClient,
  organizationSlug: string,
  hookId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${hooks(organizationSlug)}/${encodeURIComponent(hookId)}`,
  });
}

export async function listCodeLinks(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<{ readonly workKey: string | null; readonly links: readonly CodeLink[] }> {
  const { data } = await client.request<{
    workKey: string | null;
    links: readonly CodeLink[];
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/code-links`,
  });
  return data;
}

export async function removeCodeLink(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  linkId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/code-links/${encodeURIComponent(linkId)}`,
  });
}

/** `PR #42 · Add pricing page`, `3f9c2a1 · fix header`, `feature/WEB-12`. */
export function codeLinkLine(link: CodeLink): string {
  const ref =
    link.kind === 'pr'
      ? `PR #${link.externalId}`
      : link.kind === 'commit'
        ? link.externalId.slice(0, 7)
        : link.externalId;
  return link.title ? `${ref} · ${link.title}` : ref;
}
