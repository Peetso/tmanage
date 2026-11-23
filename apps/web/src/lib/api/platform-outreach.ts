import type { ApiClient } from './client';

/**
 * LANE-Q + OUTREACH MANAGER — Platform admin -> Settings -> Outreach (`/v1/platform/outreach…`):
 * campaigns (create, duplicate, rename, settings, archive, start / pause / stop), each with its own
 * e-mail (every save a version, live preview, a test to me) and recipients (view, add, change,
 * remove, import, export). Paired Exact with the API views in `e2e/contracts/api-web-shapes.ts`.
 */

export type OutreachCampaignStatus = 'paused' | 'running' | 'stopped';
export type OutreachAction = 'start' | 'pause' | 'stop';
export type OutreachLanguage = 'en' | 'ar' | 'fr' | 'es' | 'de' | 'pt-BR' | 'zh-CN' | 'ur';
export type OutreachEmailKind = 'intro' | 'followup';
export type OutreachSenderPool = 'auto' | 'chosen';
export type OutreachExclusion =
  | 'consent_country'
  | 'us_without_postal_address'
  | 'unknown_country'
  | 'no_name'
  | 'bad_email'
  | 'flagged'
  | 'contact_type'
  | 'duplicate_address'
  | 'second_at_company'
  | 'suppressed';

export const OUTREACH_LANGUAGES: readonly OutreachLanguage[] = [
  'en',
  'ar',
  'fr',
  'es',
  'de',
  'pt-BR',
  'zh-CN',
  'ur',
];

export interface OutreachRecipientView {
  readonly id: string;
  readonly company: string;
  readonly personName: string;
  readonly firstName: string;
  readonly country: string;
  readonly language: string;
  readonly sender: string | null;
  readonly senderPersonId: string;
  readonly status: string;
  readonly sentAt: string | null;
  readonly lastError: string | null;
  readonly trialRedeemedAt: string | null;
  readonly walkthroughAt: string | null;
  readonly repliedAt: string | null;
  readonly followupStatus: string | null;
  readonly followupSentAt: string | null;
  readonly optedOut: boolean;
}

export interface OutreachCampaignView {
  readonly id: string;
  readonly name: string;
  readonly status: OutreachCampaignStatus;
  readonly languages: readonly OutreachLanguage[];
  readonly senderPool: OutreachSenderPool;
  readonly dailyCap: number;
  readonly warmup: boolean;
  readonly followupEnabled: boolean;
  readonly followupDays: number;
  readonly archivedAt: string | null;
  readonly firstStartedAt: string | null;
  readonly createdAt: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly trialsRedeemed: number;
  readonly walkthroughs: number;
  readonly followupsSent: number;
  readonly replied: number;
  readonly optedOut: number;
}

export interface OutreachView {
  readonly campaigns: readonly OutreachCampaignView[];
  readonly recipients: readonly OutreachRecipientView[];
  readonly postalAddressSet: boolean;
}

export interface OutreachImportView extends OutreachView {
  readonly imported: number;
  readonly rows: number;
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
}

export interface OutreachSenderView {
  readonly id: string;
  readonly address: string;
  readonly name: string;
  readonly side: 'ar' | 'en';
  readonly chosen: boolean;
}

export interface OutreachEmailTextView {
  readonly subject: string;
  readonly body: string;
  readonly version: number | null;
  readonly savedAt: string | null;
}

export interface OutreachVersionView {
  readonly kind: OutreachEmailKind;
  readonly version: number;
  readonly languages: readonly OutreachLanguage[];
  readonly createdAt: string;
  readonly byYou: boolean;
}

export interface OutreachCampaignDetailView {
  readonly campaign: OutreachCampaignView;
  readonly senders: readonly OutreachSenderView[];
  readonly emails: Readonly<
    Record<OutreachEmailKind, Readonly<Partial<Record<OutreachLanguage, OutreachEmailTextView>>>>
  >;
  readonly versions: readonly OutreachVersionView[];
  readonly postalAddressSet: boolean;
  readonly placeholders: readonly string[];
  readonly languages: readonly OutreachLanguage[];
}

export interface OutreachEmailText {
  readonly subject: string;
  readonly body: string;
}

export interface OutreachVersionTextView {
  readonly kind: OutreachEmailKind;
  readonly version: number;
  readonly createdAt: string;
  readonly texts: Readonly<Partial<Record<OutreachLanguage, OutreachEmailText>>>;
}

export interface OutreachRecipientsView {
  readonly campaign: OutreachCampaignView;
  readonly recipients: readonly OutreachRecipientView[];
  readonly postalAddressSet: boolean;
}

export interface OutreachRecipientsImportView extends OutreachRecipientsView {
  readonly imported: number;
  readonly rows: number;
  readonly excluded: Readonly<Partial<Record<OutreachExclusion, number>>>;
}

export interface OutreachPreviewView {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly recipientId: string | null;
  readonly problems: readonly string[];
}

export interface OutreachTestSendView {
  readonly sent: boolean;
  readonly to: string;
}

export interface OutreachExportView {
  readonly filename: string;
  readonly csv: string;
  readonly rows: number;
}

export interface OutreachSettingsInput {
  readonly name?: string;
  readonly languages?: readonly OutreachLanguage[];
  readonly senderPool?: OutreachSenderPool;
  readonly senderIds?: readonly string[];
  readonly dailyCap?: number;
  readonly warmup?: boolean;
  readonly followupEnabled?: boolean;
  readonly followupDays?: number;
}

export interface OutreachDraftInput {
  readonly kind: OutreachEmailKind;
  readonly language: OutreachLanguage;
  readonly subject?: string;
  readonly body?: string;
  readonly recipientId?: string;
}

export interface OutreachPersonInput {
  readonly company?: string;
  readonly firstName?: string;
  readonly country?: string;
  readonly email?: string;
  readonly language?: OutreachLanguage;
}

export const PLATFORM_OUTREACH_QUERY_KEY = ['platform', 'outreach'] as const;
export const outreachCampaignKey = (id: string) =>
  ['platform', 'outreach', 'campaign', id] as const;
export const outreachRecipientsKey = (id: string) =>
  ['platform', 'outreach', 'campaign', id, 'recipients'] as const;

const BASE = '/v1/platform/outreach';
const campaignPath = (id: string) => `${BASE}/campaigns/${encodeURIComponent(id)}`;
const recipientPath = (id: string) => `${BASE}/recipients/${encodeURIComponent(id)}`;

async function call<T>(
  client: ApiClient,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const { data } = await client.request<T>({
    ...(method === 'GET' ? {} : { method }),
    path,
    ...(body === undefined ? {} : { body }),
  });
  return data;
}

export function fetchOutreach(client: ApiClient): Promise<OutreachView> {
  return call(client, 'GET', BASE);
}

export function importOutreach(
  client: ApiClient,
  input: { readonly csv: string; readonly name?: string },
): Promise<OutreachImportView> {
  return call(client, 'POST', `${BASE}/import`, input);
}

export function moveOutreachCampaign(
  client: ApiClient,
  campaignId: string,
  action: OutreachAction,
): Promise<OutreachView> {
  return call(client, 'POST', `${campaignPath(campaignId)}/${action}`);
}

export function markOutreachBounced(client: ApiClient, recipientId: string): Promise<OutreachView> {
  return call(client, 'POST', `${recipientPath(recipientId)}/bounced`);
}

export function createOutreachCampaign(
  client: ApiClient,
  input: OutreachSettingsInput & { readonly name: string },
): Promise<OutreachCampaignDetailView> {
  return call(client, 'POST', `${BASE}/campaigns`, input);
}

export function fetchOutreachCampaign(
  client: ApiClient,
  id: string,
): Promise<OutreachCampaignDetailView> {
  return call(client, 'GET', campaignPath(id));
}

export function updateOutreachCampaign(
  client: ApiClient,
  id: string,
  input: OutreachSettingsInput,
): Promise<OutreachCampaignDetailView> {
  return call(client, 'PATCH', campaignPath(id), input);
}

export function duplicateOutreachCampaign(
  client: ApiClient,
  id: string,
  name?: string,
): Promise<OutreachCampaignDetailView> {
  return call(client, 'POST', `${campaignPath(id)}/duplicate`, name === undefined ? {} : { name });
}

export function archiveOutreachCampaign(
  client: ApiClient,
  id: string,
  archived: boolean,
): Promise<OutreachCampaignDetailView> {
  return call(client, 'POST', `${campaignPath(id)}/${archived ? 'archive' : 'unarchive'}`);
}

export function saveOutreachEmail(
  client: ApiClient,
  id: string,
  kind: OutreachEmailKind,
  input: {
    readonly texts: Readonly<Partial<Record<OutreachLanguage, OutreachEmailText>>>;
    readonly confirmStarted?: boolean;
  },
): Promise<OutreachCampaignDetailView> {
  return call(client, 'PUT', `${campaignPath(id)}/emails/${kind}`, input);
}

export function fetchOutreachVersion(
  client: ApiClient,
  id: string,
  kind: OutreachEmailKind,
  version: number,
): Promise<OutreachVersionTextView> {
  return call(client, 'GET', `${campaignPath(id)}/emails/${kind}/versions/${String(version)}`);
}

export function previewOutreachEmail(
  client: ApiClient,
  id: string,
  input: OutreachDraftInput,
): Promise<OutreachPreviewView> {
  return call(client, 'POST', `${campaignPath(id)}/preview`, input);
}

export function testSendOutreachEmail(
  client: ApiClient,
  id: string,
  input: OutreachDraftInput,
): Promise<OutreachTestSendView> {
  return call(client, 'POST', `${campaignPath(id)}/test-send`, input);
}

export function fetchOutreachRecipients(
  client: ApiClient,
  id: string,
): Promise<OutreachRecipientsView> {
  return call(client, 'GET', `${campaignPath(id)}/recipients`);
}

export function addOutreachRecipient(
  client: ApiClient,
  id: string,
  input: OutreachPersonInput,
): Promise<OutreachRecipientsView> {
  return call(client, 'POST', `${campaignPath(id)}/recipients`, input);
}

export function importOutreachRecipients(
  client: ApiClient,
  id: string,
  csv: string,
): Promise<OutreachRecipientsImportView> {
  return call(client, 'POST', `${campaignPath(id)}/import`, { csv });
}

export function exportOutreachRecipients(
  client: ApiClient,
  id: string,
): Promise<OutreachExportView> {
  return call(client, 'POST', `${campaignPath(id)}/export`);
}

export function updateOutreachRecipient(
  client: ApiClient,
  recipientId: string,
  input: OutreachPersonInput,
): Promise<OutreachRecipientsView> {
  return call(client, 'PATCH', recipientPath(recipientId), input);
}

export function removeOutreachRecipient(
  client: ApiClient,
  recipientId: string,
): Promise<OutreachRecipientsView> {
  return call(client, 'DELETE', recipientPath(recipientId));
}

export function markOutreachReplied(
  client: ApiClient,
  recipientId: string,
): Promise<OutreachRecipientsView> {
  return call(client, 'POST', `${recipientPath(recipientId)}/replied`);
}
