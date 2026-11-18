import type { ApiClient } from './client';

/**
 * EMAILBUILD2 — the "Tips and reminders" switch and the "Feature news" card on platform settings
 * (`/v1/platform/person-mail…`). Paired Exact with the API views in
 * `e2e/contracts/api-web-shapes.ts`; a field renamed on either side is a compile error there.
 */

export interface FeatureNewsView {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly bodyEn: string;
  readonly bodyAr: string;
  readonly link: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

export interface PersonMailStateView {
  readonly tipsEnabled: boolean;
  readonly news: readonly FeatureNewsView[];
}

export type FeatureNewsInput = Pick<
  FeatureNewsView,
  'titleEn' | 'titleAr' | 'bodyEn' | 'bodyAr' | 'link'
>;

export const PLATFORM_PERSON_MAIL_QUERY_KEY = ['platform', 'person-mail'] as const;

export async function fetchPersonMail(client: ApiClient): Promise<PersonMailStateView> {
  const { data } = await client.request<PersonMailStateView>({ path: '/v1/platform/person-mail' });
  return data;
}

export async function setTipsSwitch(
  client: ApiClient,
  enabled: boolean,
): Promise<PersonMailStateView> {
  const { data } = await client.request<PersonMailStateView>({
    method: 'PUT',
    path: '/v1/platform/person-mail/switch',
    body: { enabled },
  });
  return data;
}

export async function addFeatureNews(
  client: ApiClient,
  input: FeatureNewsInput,
): Promise<PersonMailStateView> {
  const { data } = await client.request<PersonMailStateView>({
    method: 'POST',
    path: '/v1/platform/person-mail/news',
    body: input,
  });
  return data;
}

export async function sendFeatureNews(
  client: ApiClient,
  newsId: string,
): Promise<PersonMailStateView> {
  const { data } = await client.request<PersonMailStateView>({
    method: 'POST',
    path: `/v1/platform/person-mail/news/${encodeURIComponent(newsId)}/send`,
  });
  return data;
}
