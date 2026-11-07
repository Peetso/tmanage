import type { ApiClient } from './client';

/**
 * R20-a — the preview card `GET /v1/organizations/:orgSlug/unfurl?url=` answers for an
 * allow-listed link (Figma, GitHub, Google Docs, OneDrive). Any other link is refused (422) and
 * simply gets no card; the link itself stays clickable.
 */
export interface UnfurlCard {
  readonly provider: 'figma' | 'github' | 'google_docs' | 'onedrive';
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly thumbnailUrl: string | null;
  readonly openUrl: string;
}

const PROVIDER_NAMES: Readonly<Record<UnfurlCard['provider'], string>> = {
  figma: 'Figma',
  github: 'GitHub',
  google_docs: 'Google Docs',
  onedrive: 'OneDrive',
};

/** The provider's brand name, shown as the card's site line. */
export function unfurlSiteName(card: UnfurlCard): string | null {
  return PROVIDER_NAMES[card.provider] ?? null;
}

export async function getUnfurlCard(
  client: ApiClient,
  organizationSlug: string,
  url: string,
): Promise<UnfurlCard> {
  const parameters = new URLSearchParams({ url });
  const { data } = await client.request<UnfurlCard>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/unfurl?${parameters.toString()}`,
  });
  return data;
}
