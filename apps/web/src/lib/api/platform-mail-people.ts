import type { ApiClient } from './client';

/**
 * EMAILBUILD — the "E-mail people" card on platform settings (`/v1/platform/mail-people…`): the
 * TManage people who sign tips and reminders. Paired Exact with the API views in
 * `e2e/contracts/api-web-shapes.ts`; a field renamed on either side is a compile error there.
 */

export type MailPersonLanguages = 'en' | 'ar' | 'en+ar';
export type MailPersonRegion = 'me' | 'west' | 'asia';
export type MailPersonTopic = 'onboarding' | 'features' | 'news' | 'security' | 'success';

export const MAIL_PERSON_LANGUAGE_VALUES: readonly MailPersonLanguages[] = ['en', 'ar', 'en+ar'];
export const MAIL_PERSON_REGION_VALUES: readonly MailPersonRegion[] = ['me', 'west', 'asia'];
export const MAIL_PERSON_TOPIC_VALUES: readonly MailPersonTopic[] = [
  'onboarding',
  'features',
  'news',
  'security',
  'success',
];

export interface MailPersonView {
  readonly id: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly roleEn: string;
  readonly roleAr: string;
  readonly address: string;
  readonly languages: MailPersonLanguages;
  readonly region: MailPersonRegion;
  readonly topic: MailPersonTopic;
  readonly active: boolean;
}

export type MailPersonInput = Omit<MailPersonView, 'id'>;

/** MAILSTATUS (ADR-0013). One role mailbox's login state (never a value). */
export interface MailboxLoginView {
  readonly mailbox: 'noreply' | 'hello' | 'support' | 'security';
  readonly address: string | null;
  readonly state: 'ok' | 'login_refused' | 'unreachable' | 'not_configured';
}

export interface MailPeopleView {
  readonly people: readonly MailPersonView[];
  /** MAILSTATUS. Each role mailbox's login state; `null` when mail does not go out over SMTP. */
  readonly mailboxes: readonly MailboxLoginView[] | null;
}

/**
 * PERSONMAIL (ADR-0013). `own_mailbox`: the person's mail leaves from their own mailbox; `none`:
 * the shared mailbox password is not set, so it is not sent at all.
 */
export type MailPersonRoute = 'own_mailbox' | 'none';

export interface MailPersonTestView {
  readonly sent: boolean;
  readonly route: MailPersonRoute;
  readonly address: string;
}

export const PLATFORM_MAIL_PEOPLE_QUERY_KEY = ['platform', 'mail-people'] as const;

export async function fetchMailPeople(client: ApiClient): Promise<MailPeopleView> {
  const { data } = await client.request<MailPeopleView>({ path: '/v1/platform/mail-people' });
  return data;
}

export async function addMailPerson(
  client: ApiClient,
  input: MailPersonInput,
): Promise<MailPeopleView> {
  const { data } = await client.request<MailPeopleView>({
    method: 'POST',
    path: '/v1/platform/mail-people',
    body: input,
  });
  return data;
}

export async function importMailPeople(client: ApiClient, csv: string): Promise<MailPeopleView> {
  const { data } = await client.request<MailPeopleView>({
    method: 'POST',
    path: '/v1/platform/mail-people/import',
    body: { csv },
  });
  return data;
}

export async function setMailPersonActive(
  client: ApiClient,
  personId: string,
  active: boolean,
): Promise<MailPeopleView> {
  const { data } = await client.request<MailPeopleView>({
    method: 'PUT',
    path: `/v1/platform/mail-people/${encodeURIComponent(personId)}`,
    body: { active },
  });
  return data;
}

export async function sendMailPersonTest(
  client: ApiClient,
  personId: string,
  language: 'en' | 'ar',
): Promise<MailPersonTestView> {
  const { data } = await client.request<MailPersonTestView>({
    method: 'POST',
    path: `/v1/platform/mail-people/${encodeURIComponent(personId)}/test`,
    body: { language },
  });
  return data;
}
