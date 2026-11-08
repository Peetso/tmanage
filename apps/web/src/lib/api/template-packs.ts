import type { ApiClient } from './client';

/**
 * 54-22. The template-packs gallery endpoints, gated on `project.manage`:
 * `GET …/projects/templates/packs` lists the built-in packs with this workspace's install state;
 * `POST …/projects/templates/packs/:packKey/install` installs one, creating its project templates.
 */

export interface TemplatePackView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly templateNames: readonly string[];
  readonly docs: readonly string[];
  readonly automations: readonly string[];
  readonly installed: boolean;
  /** An ISO-8601 instant; null while the pack is not installed. */
  readonly installedAt: string | null;
}

export interface TemplatePackInstallResult {
  readonly pack: TemplatePackView;
  readonly templatesCreated: number;
  readonly templatesSkipped: number;
}

function packsPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/templates/packs`;
}

export async function listTemplatePacks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly TemplatePackView[]> {
  const { data } = await client.request<{ packs: readonly TemplatePackView[] }>({
    path: packsPath(organizationSlug),
  });
  return data.packs;
}

export async function installTemplatePack(
  client: ApiClient,
  organizationSlug: string,
  packKey: string,
): Promise<TemplatePackInstallResult> {
  const { data } = await client.request<TemplatePackInstallResult>({
    method: 'POST',
    path: `${packsPath(organizationSlug)}/${encodeURIComponent(packKey)}/install`,
  });
  return data;
}
