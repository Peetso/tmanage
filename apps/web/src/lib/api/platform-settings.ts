import type { ApiClient } from './client';
import type { PlatformSettingsView } from './platform-admin';

/**
 * Platform admin v2 · PA-10 — platform settings, integrations, feature flags and announcements
 * (`/v1/platform/settings*`, `/v1/platform/flags*`, `/v1/platform/announcements*`) and the public
 * announcement banner read (`/public/site/announcements`).
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired Exact with the API views in
 * `e2e/contracts/api-web-shapes.ts`; a field renamed on either side is a compile error there.
 */

export type PlatformBillingMode = 'beta_free' | 'paid';
export type PlatformSettingSource = 'environment' | 'platform_setting';

export interface PlatformSettingChangeView {
  readonly at: string | null;
  readonly by: string | null;
}

/** `GET /v1/platform/settings` — every D1 card in one read. */
export interface PlatformSettingsFullView extends PlatformSettingsView {
  readonly billingMode: {
    readonly mode: PlatformBillingMode;
    readonly source: PlatformSettingSource;
    readonly environmentDefault: PlatformBillingMode;
    readonly organizationCount: number;
    readonly overrideCount: number | null;
  };
  readonly betaBanner: {
    readonly on: boolean;
    readonly textEn: string;
    readonly textAr: string;
  };
  readonly retention: {
    readonly orgPurgeDays: number;
    readonly userPurgeDays: number;
    readonly contentPurgeDays: number;
  };
  readonly supportDefaults: {
    readonly maxMinutes: number;
    readonly requireReason: boolean;
  };
  readonly stepUpMinutes: number;
  readonly changes: {
    readonly publicSignup: PlatformSettingChangeView;
    readonly aiAccess: PlatformSettingChangeView;
    readonly billingMode: PlatformSettingChangeView;
    readonly betaBanner: PlatformSettingChangeView;
    readonly retention: PlatformSettingChangeView;
    readonly supportDefaults: PlatformSettingChangeView;
  };
}

export type PlatformIntegrationKey =
  | 'google_drive'
  | 'onedrive'
  | 'google_calendar'
  | 'microsoft_calendar'
  | 'figma'
  | 'github'
  | 'jira'
  | 'email'
  | 'mcp';

export interface PlatformIntegrationView {
  readonly key: PlatformIntegrationKey;
  readonly configured: boolean;
  readonly missingEnvironment: readonly string[];
  readonly enabled: boolean;
  readonly environmentForcedOff: boolean;
  /** 51-15p: `false` for a reading-only row (e-mail sending). */
  readonly switchable: boolean;
  /** `null` where the service has no per-workspace connection (e-mail sending). */
  readonly connectedOrganizations: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly lastSuccessAt: string | null;
}

/** 51-07 — the worker heartbeat, for "Background jobs: last batch N s ago". */
export interface BackgroundJobsView {
  readonly worker: 'ok' | 'stale' | 'not_configured';
  readonly lastBatchAt: string | null;
  readonly lastBatchAgeSeconds: number | null;
  readonly maxAgeSeconds: number;
}

export interface PlatformIntegrationsView {
  readonly integrations: readonly PlatformIntegrationView[];
  readonly backgroundJobs: BackgroundJobsView;
}

export type PlatformFlagKey =
  | 'chat'
  | 'meetings'
  | 'docs'
  | 'people'
  | 'insights'
  | 'automations'
  | 'client_portal'
  | 'billing'
  | 'copilot'
  // Plan 52 rollout flags (52-24).
  | 'time_tracking'
  | 'finance_rates_budgets'
  | 'expenses'
  | 'quotes'
  | 'client_invoicing'
  | 'einvoicing_ksa'
  | 'finance_reports'
  | 'proofing'
  | 'approval_links'
  | 'public_forms'
  // Plan 62 (62-27, 62-A1a/b): the signals engine, owner alert settings and the Home briefing.
  | 'business_briefing'
  // 62-28: the optional AI wording of the weekly digest.
  | 'ai_digest_wording';
export type PlatformFlagRollout = 'everyone' | 'allowlist' | 'percentage';

export interface PlatformFlagView {
  readonly key: PlatformFlagKey;
  readonly enabled: boolean;
  readonly rollout: PlatformFlagRollout;
  readonly percentage: number | null;
  readonly allowlistOrganizationIds: readonly string[];
  readonly codeDefault: boolean;
  readonly lockedValue: boolean | null;
  readonly forcedOn: number;
  readonly forcedOff: number;
  readonly usedByOrganizations: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface PlatformFlagsView {
  readonly flags: readonly PlatformFlagView[];
  readonly organizationCount: number;
}

export interface PlatformFlagOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly allowlisted: boolean;
  readonly forced: 'on' | 'off' | null;
  readonly organizationSetting: boolean | null;
  readonly effective: boolean;
}

export interface PlatformFlagOrganizationsView {
  readonly key: PlatformFlagKey;
  readonly organizations: readonly PlatformFlagOrganizationView[];
}

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';
export type AnnouncementAudience = 'everyone' | 'organizations' | 'clients';
export type AnnouncementStatus = 'draft' | 'scheduled' | 'live' | 'expired';

export interface PlatformAnnouncementView {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly bodyEn: string;
  readonly bodyAr: string | null;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly audience: AnnouncementAudience;
  readonly audienceOrganizationIds: readonly string[];
  readonly dismissible: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly published: boolean;
  readonly status: AnnouncementStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformAnnouncementsView {
  readonly announcements: readonly PlatformAnnouncementView[];
}

/** The banner one person sees, already in their language. */
export interface PublicAnnouncementView {
  readonly id: string;
  readonly locale: 'en' | 'ar';
  readonly title: string;
  readonly body: string;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly dismissible: boolean;
  readonly endsAt: string | null;
}

export interface PublicAnnouncementsView {
  readonly announcement: PublicAnnouncementView | null;
  readonly asOf: string;
}

// ---- request bodies (request-side shapes, not paired) ----

export interface FlagOverrideInput {
  readonly organizationId: string;
  readonly state: 'on' | 'off' | 'none';
}

export interface FlagUpdateInput {
  readonly enabled: boolean;
  readonly rollout: PlatformFlagRollout;
  readonly percentage?: number | null;
  readonly allowlistOrganizationIds?: readonly string[];
  readonly overrides?: readonly FlagOverrideInput[];
  readonly reason?: string;
}

export interface AnnouncementInput {
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly bodyEn: string;
  readonly bodyAr: string | null;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly audience: AnnouncementAudience;
  readonly audienceOrganizationIds: readonly string[];
  readonly dismissible: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly published?: boolean;
  readonly reason?: string;
}

// ---- settings ----

export const PLATFORM_SETTINGS_QUERY_KEY = ['platform', 'settings'] as const;
export const PLATFORM_INTEGRATIONS_QUERY_KEY = ['platform', 'settings', 'integrations'] as const;
export const PLATFORM_FLAGS_QUERY_KEY = ['platform', 'flags'] as const;
export const PLATFORM_ANNOUNCEMENTS_QUERY_KEY = ['platform', 'announcements'] as const;

export async function fetchPlatformSettingsFull(
  client: ApiClient,
): Promise<PlatformSettingsFullView> {
  const { data } = await client.request<PlatformSettingsFullView>({
    path: '/v1/platform/settings',
  });
  return data;
}

async function putSetting(
  client: ApiClient,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<PlatformSettingsFullView> {
  const { data } = await client.request<PlatformSettingsFullView>({
    method: 'PUT',
    path: `/v1/platform/settings/${path}`,
    body,
  });
  return data;
}

export function setPlatformBillingMode(
  client: ApiClient,
  mode: PlatformBillingMode,
  reason: string,
): Promise<PlatformSettingsFullView> {
  return putSetting(client, 'billing-mode', { mode, reason });
}

export function setPlatformBetaBanner(
  client: ApiClient,
  input: { readonly on: boolean; readonly textEn: string; readonly textAr: string },
): Promise<PlatformSettingsFullView> {
  return putSetting(client, 'beta-banner', input);
}

export function setPlatformRetention(
  client: ApiClient,
  input: {
    readonly orgPurgeDays: number;
    readonly userPurgeDays: number;
    readonly contentPurgeDays: number;
  },
): Promise<PlatformSettingsFullView> {
  return putSetting(client, 'retention', input);
}

export function setPlatformSupportDefaults(
  client: ApiClient,
  input: { readonly maxMinutes: number; readonly requireReason: boolean },
): Promise<PlatformSettingsFullView> {
  return putSetting(client, 'support-defaults', input);
}

export async function fetchPlatformIntegrations(
  client: ApiClient,
): Promise<PlatformIntegrationsView> {
  const { data } = await client.request<PlatformIntegrationsView>({
    path: '/v1/platform/settings/integrations',
  });
  return data;
}

export async function setPlatformIntegration(
  client: ApiClient,
  key: PlatformIntegrationKey,
  enabled: boolean,
  reason: string,
): Promise<PlatformIntegrationsView> {
  const { data } = await client.request<PlatformIntegrationsView>({
    method: 'PUT',
    path: `/v1/platform/settings/integrations/${encodeURIComponent(key)}`,
    body: { enabled, reason },
  });
  return data;
}

// ---- feature flags ----

export async function fetchPlatformFlags(client: ApiClient): Promise<PlatformFlagsView> {
  const { data } = await client.request<PlatformFlagsView>({ path: '/v1/platform/flags' });
  return data;
}

export async function fetchPlatformFlagOrganizations(
  client: ApiClient,
  key: PlatformFlagKey,
  query: string,
): Promise<PlatformFlagOrganizationsView> {
  const { data } = await client.request<PlatformFlagOrganizationsView>({
    path: `/v1/platform/flags/${encodeURIComponent(key)}/organizations${
      query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
    }`,
  });
  return data;
}

export async function updatePlatformFlag(
  client: ApiClient,
  key: PlatformFlagKey,
  input: FlagUpdateInput,
): Promise<PlatformFlagsView> {
  const { data } = await client.request<PlatformFlagsView>({
    method: 'PUT',
    path: `/v1/platform/flags/${encodeURIComponent(key)}`,
    body: input,
  });
  return data;
}

// ---- announcements ----

export async function fetchPlatformAnnouncements(
  client: ApiClient,
): Promise<PlatformAnnouncementsView> {
  const { data } = await client.request<PlatformAnnouncementsView>({
    path: '/v1/platform/announcements',
  });
  return data;
}

export async function createPlatformAnnouncement(
  client: ApiClient,
  input: AnnouncementInput,
): Promise<PlatformAnnouncementView> {
  const { data } = await client.request<PlatformAnnouncementView>({
    method: 'POST',
    path: '/v1/platform/announcements',
    body: input,
  });
  return data;
}

export async function updatePlatformAnnouncement(
  client: ApiClient,
  id: string,
  input: Partial<AnnouncementInput>,
): Promise<PlatformAnnouncementView> {
  const { data } = await client.request<PlatformAnnouncementView>({
    method: 'PATCH',
    path: `/v1/platform/announcements/${encodeURIComponent(id)}`,
    body: input,
  });
  return data;
}

export async function setPlatformAnnouncementPublished(
  client: ApiClient,
  id: string,
  published: boolean,
): Promise<PlatformAnnouncementView> {
  const { data } = await client.request<PlatformAnnouncementView>({
    method: 'POST',
    path: `/v1/platform/announcements/${encodeURIComponent(id)}/${published ? 'publish' : 'unpublish'}`,
    body: {},
  });
  return data;
}

export async function archivePlatformAnnouncement(client: ApiClient, id: string): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `/v1/platform/announcements/${encodeURIComponent(id)}`,
    body: {},
  });
}

/** The public banner read: no session needed (it also shows in client portals). */
export async function fetchPublicAnnouncement(
  client: ApiClient,
  input: {
    readonly locale: 'en' | 'ar';
    readonly surface: 'app' | 'portal' | 'site';
    readonly organizationId?: string | null;
    /** The `[orgSlug]` in the URL; the API resolves it only for a chosen-organizations banner. */
    readonly organizationSlug?: string | null;
  },
): Promise<PublicAnnouncementsView> {
  const query = new URLSearchParams({ locale: input.locale, surface: input.surface });
  if (input.organizationId) query.set('organizationId', input.organizationId);
  if (input.organizationSlug) query.set('organizationSlug', input.organizationSlug);
  const { data } = await client.request<PublicAnnouncementsView>({
    path: `/public/site/announcements?${query.toString()}`,
    authentication: 'none',
  });
  return data;
}
