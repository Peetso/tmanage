import type { ApiClient } from './client';

/**
 * Row 55-17 · in-app support conversations with the TManage team.
 *
 * - Member side, `/v1/organizations/:orgSlug/support/threads…`: a person sees their own
 *   conversations (an org admin sees all of the workspace's); the API decides, not this file.
 * - Platform side, `/v1/platform/support/threads…`: the team's inbox across workspaces
 *   (`platform.orgs.view` to read, `platform.orgs.edit` to reply or change status).
 */

export type SupportStatus = 'open' | 'waiting' | 'closed';
export type SupportAuthorKind = 'member' | 'platform';

export const SUPPORT_STATUSES: readonly SupportStatus[] = ['open', 'waiting', 'closed'];

export interface SupportMessage {
  readonly id: string;
  readonly authorKind: SupportAuthorKind;
  readonly authorName: string | null;
  readonly mine: boolean;
  readonly body: string;
  readonly attachmentName: string | null;
  readonly createdAt: string;
}

/** 57-10 · request category and priority, and the SLA clock the API computes (never the client). */
export type SupportCategory =
  'question' | 'problem' | 'billing' | 'account' | 'feature_request' | 'other';
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  'question',
  'problem',
  'billing',
  'account',
  'feature_request',
  'other',
];
export const SUPPORT_PRIORITIES: readonly SupportPriority[] = ['low', 'normal', 'high', 'urgent'];

export interface SupportSlaClock {
  readonly paused: boolean;
  readonly firstResponse: {
    readonly targetMinutes: number;
    readonly elapsedMinutes: number;
    readonly dueAt: string;
    readonly respondedAt: string | null;
    readonly breached: boolean;
  };
  readonly resolution: {
    readonly targetMinutes: number;
    readonly elapsedMinutes: number;
    readonly dueAt: string | null;
    readonly resolvedAt: string | null;
    readonly breached: boolean;
  };
  readonly breached: boolean;
}

export interface SupportThread {
  readonly id: string;
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  /** Only on the writer's own threads and in the platform inbox; null otherwise. */
  readonly sla: SupportSlaClock | null;
  /** The plan whose targets were captured at opening; null where `sla` is null. */
  readonly plan: string | null;
  readonly subject: string;
  readonly status: SupportStatus;
  readonly contextPath: string | null;
  readonly appVersion: string | null;
  readonly startedByName: string | null;
  readonly mine: boolean;
  readonly messageCount: number;
  readonly lastAuthorKind: SupportAuthorKind;
  readonly lastMessageAt: string;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** What a new request would get now: the plan, the normal first-response target, the time zone. */
export interface SupportPolicy {
  readonly plan: string;
  readonly firstResponseMinutes: number;
  readonly timezone: string;
}

export interface SupportOverview {
  readonly threads: readonly SupportThread[];
  readonly policy: SupportPolicy;
}

export interface SupportThreadDetail {
  readonly thread: SupportThread;
  readonly organizationSlug: string | null;
  readonly messages: readonly SupportMessage[];
}

export interface PlatformSupportThread extends SupportThread {
  readonly organizationId: string;
  readonly organizationSlug: string | null;
  readonly organizationName: string | null;
  readonly startedByEmail: string | null;
}

export interface PlatformSupportDetail {
  readonly thread: PlatformSupportThread;
  readonly messages: readonly SupportMessage[];
}

export interface NewSupportThreadInput {
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly subject: string;
  readonly message: string;
  readonly contextPath: string | null;
  readonly appVersion: string | null;
  readonly attachmentFileId: string | null;
}

/** The web build's version, shown to the person before it is sent with their message. */
export const APP_VERSION = process.env['NEXT_PUBLIC_APP_VERSION'] ?? '0.1.0';

/** The project id in a project page's address (`/:org/projects/:projectId/…`), else `null`. */
export function projectIdFromPath(path: string): string | null {
  const match = /^\/[^/]+\/projects\/([0-9a-f-]{36})(?:\/|$)/iu.exec(path);
  return match?.[1] ?? null;
}

/** 57-10 · "Get help"'s `?from=` page: only a page inside this workspace is sent as context. */
export function cleanFromPath(from: string | undefined, organizationSlug: string): string | null {
  if (!from || from.length > 300 || /[?#\\]/u.test(from)) return null;
  const prefix = `/${organizationSlug}`;
  if (from.startsWith(`${prefix}/help`)) return null;
  return from === prefix || from.startsWith(`${prefix}/`) ? from : null;
}

export const supportThreadsKey = (organizationSlug: string) =>
  ['support-threads', organizationSlug] as const;
export const supportThreadKey = (organizationSlug: string, id: string) =>
  ['support-threads', organizationSlug, id] as const;
export const PLATFORM_SUPPORT_QUERY_KEY = ['platform', 'support-threads'] as const;

const base = (slug: string) => `/v1/organizations/${encodeURIComponent(slug)}/support/threads`;

export async function fetchSupportThreads(
  client: ApiClient,
  organizationSlug: string,
): Promise<SupportOverview> {
  const { data } = await client.request<SupportOverview>({ path: base(organizationSlug) });
  return data;
}

export async function fetchSupportThread(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<SupportThreadDetail> {
  const { data } = await client.request<SupportThreadDetail>({
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
  return data;
}

export async function createSupportThread(
  client: ApiClient,
  organizationSlug: string,
  input: NewSupportThreadInput,
): Promise<SupportThreadDetail> {
  const { data } = await client.request<SupportThreadDetail>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

export async function postSupportMessage(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  message: string,
  attachmentFileId: string | null = null,
): Promise<SupportThreadDetail> {
  const { data } = await client.request<SupportThreadDetail>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}/messages`,
    body: { message, attachmentFileId },
  });
  return data;
}

export async function closeSupportThread(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<SupportThreadDetail> {
  const { data } = await client.request<SupportThreadDetail>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}/close`,
  });
  return data;
}

/** 57-10 · the inbox's server-side filters; the clock behind `breached` is computed by the API. */
export interface PlatformSupportFilter {
  readonly breached?: boolean;
  readonly priority?: SupportPriority | null;
}

export const platformSupportListKey = (filter: PlatformSupportFilter) =>
  [
    ...PLATFORM_SUPPORT_QUERY_KEY,
    'list',
    filter.breached === true,
    filter.priority ?? null,
  ] as const;

export async function fetchPlatformSupportThreads(
  client: ApiClient,
  filter: PlatformSupportFilter = {},
): Promise<readonly PlatformSupportThread[]> {
  const params = new URLSearchParams();
  if (filter.breached) params.set('breached', '1');
  if (filter.priority) params.set('priority', filter.priority);
  const query = params.toString();
  const { data } = await client.request<{ readonly threads: readonly PlatformSupportThread[] }>({
    path: `/v1/platform/support/threads${query === '' ? '' : `?${query}`}`,
  });
  return data.threads;
}

/** 57-10 · the published targets (public, static policy): plan → first response, the hours. */
export interface SupportTargets {
  readonly hours: { readonly days: string; readonly open: string; readonly close: string };
  readonly plans: readonly {
    readonly plan: string;
    readonly firstResponseBusinessMinutes: number;
  }[];
  readonly priorities: readonly {
    readonly priority: SupportPriority;
    readonly firstResponseFactor: number;
    readonly resolutionMinutes: number;
  }[];
}

export const SUPPORT_TARGETS_QUERY_KEY = ['support-targets'] as const;

export async function fetchSupportTargets(client: ApiClient): Promise<SupportTargets> {
  const { data } = await client.request<SupportTargets>({
    path: '/v1/public/site/support-targets',
  });
  return data;
}

export async function fetchPlatformSupportThread(
  client: ApiClient,
  id: string,
): Promise<PlatformSupportDetail> {
  const { data } = await client.request<PlatformSupportDetail>({
    path: `/v1/platform/support/threads/${encodeURIComponent(id)}`,
  });
  return data;
}

export async function replyPlatformSupport(
  client: ApiClient,
  id: string,
  message: string,
): Promise<PlatformSupportDetail> {
  const { data } = await client.request<PlatformSupportDetail>({
    method: 'POST',
    path: `/v1/platform/support/threads/${encodeURIComponent(id)}/messages`,
    body: { message },
  });
  return data;
}

export async function setPlatformSupportStatus(
  client: ApiClient,
  id: string,
  status: SupportStatus,
): Promise<PlatformSupportDetail> {
  const { data } = await client.request<PlatformSupportDetail>({
    method: 'POST',
    path: `/v1/platform/support/threads/${encodeURIComponent(id)}/status`,
    body: { status },
  });
  return data;
}
