import type { ApiClient } from './client';

/**
 * 54-05 Slack + 54-06 Teams (R15-c API, R46 L2 screen) — pasted incoming-webhook channel links.
 * The URL is write-only: it is sent once on create and never returned; a link shows its host only.
 * Mirrors the API's `ChannelLinkView` (automations/channel-links.service.ts).
 */

export const CHANNEL_KINDS = ['slack', 'teams'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** The notices a channel may receive. Mirrors the API's `WEBHOOK_EVENT_KINDS`. */
export const CHANNEL_EVENT_KINDS = [
  'work.created',
  'work.updated',
  'work.completed',
  'approval.decided',
  'document.published',
  'client_request.created',
  'client_request.transitioned',
  'meeting.scheduled',
] as const;

export interface ChannelLinkView {
  readonly id: string;
  readonly kind: string;
  readonly connectionId: string;
  readonly projectId: string | null;
  readonly label: string | null;
  readonly urlHost: string;
  readonly events: readonly string[];
  readonly locale: string;
  readonly status: string;
  readonly failureStreak: number;
  readonly pausedReason: string | null;
  readonly lastPostedAt: string | null;
  readonly createdAt: string;
}

export interface CreateChannelLinkInput {
  readonly webhookUrl: string;
  readonly events: readonly string[];
  readonly projectId: string | null;
  readonly locale: 'en' | 'ar';
  readonly label?: string;
}

/**
 * The same host rule the API applies (the API is the authority; this only spares a round trip):
 * https, Slack `hooks.slack.com`; Teams `*.webhook.office.com`, `outlook.office.com`, or a
 * Workflows trigger (`*.logic.azure.com`, `*.powerautomate.com`).
 */
export function channelUrlLooksRight(kind: ChannelKind, raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (kind === 'slack') return host === 'hooks.slack.com';
  if (host === 'outlook.office.com') return true;
  return ['.webhook.office.com', '.logic.azure.com', '.powerautomate.com'].some((suffix) =>
    host.endsWith(suffix),
  );
}

export const channelLinksQueryKey = (organizationSlug: string) =>
  ['channel-links', organizationSlug] as const;

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations`;
}

export async function listChannelLinks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ChannelLinkView[]> {
  const { data } = await client.request<{ links: readonly ChannelLinkView[] }>({
    path: `${base(organizationSlug)}/channel-links`,
  });
  return data.links;
}

export async function createChannelLink(
  client: ApiClient,
  organizationSlug: string,
  kind: ChannelKind,
  input: CreateChannelLinkInput,
): Promise<ChannelLinkView> {
  const { data } = await client.request<ChannelLinkView>({
    method: 'POST',
    path: `${base(organizationSlug)}/${kind}/channel-links`,
    body: input,
  });
  return data;
}

export async function removeChannelLink(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/channel-links/${encodeURIComponent(id)}`,
  });
}

export async function testChannelLink(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'POST',
    path: `${base(organizationSlug)}/channel-links/${encodeURIComponent(id)}/test`,
  });
}

export async function resumeChannelLink(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<ChannelLinkView> {
  const { data } = await client.request<ChannelLinkView>({
    method: 'POST',
    path: `${base(organizationSlug)}/channel-links/${encodeURIComponent(id)}/resume`,
  });
  return data;
}
