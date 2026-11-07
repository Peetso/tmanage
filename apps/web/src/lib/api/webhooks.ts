import type { ApiClient } from './client';

/**
 * Automations webhooks (module 17, x166).
 *
 * This module wraps the webhook-endpoints API: list the organization's endpoints, register one, and
 * enable/disable one. The one exported response shape is {@link WebhookEndpointSummary}, paired Exact
 * with the API's `WebhookEndpointView` in the contracts gate. The signing secret is write-only: it is
 * sent on register and never returned on any read, so it is absent from the response shape.
 *
 * This slice registers and validates endpoints only; actual delivery to third parties is a later
 * slice (external egress + retry infra).
 */

/** The event kinds an endpoint may subscribe to. Mirrors the API's `WEBHOOK_EVENT_KINDS`. */
export const WEBHOOK_EVENT_KINDS = [
  'work.created',
  'work.updated',
  'work.completed',
  'approval.decided',
  'document.published',
  'client_request.created',
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

/**
 * Plain names for the event kinds (TXT-03 — "raw event codes" → "plain sentences"). The raw kind
 * (`work.created`) is the stable wire value an endpoint subscribes to; these are the words shown
 * in the picker and the endpoint list instead. `satisfies` keeps a new kind a compile error here
 * until it is given a label, so the screen can never fall back to a dotted code.
 */
const WEBHOOK_EVENT_LABELS = {
  'work.created': 'Work item created',
  'work.updated': 'Work item updated',
  'work.completed': 'Work item completed',
  'approval.decided': 'Approval decided',
  'document.published': 'Document published',
  'client_request.created': 'Client request submitted',
} as const satisfies Record<WebhookEventKind, string>;

/** The plain name for an event kind, for display. Falls back to a de-coded kind for an older value. */
export function webhookEventLabel(kind: string): string {
  if ((WEBHOOK_EVENT_KINDS as readonly string[]).includes(kind)) {
    return WEBHOOK_EVENT_LABELS[kind as WebhookEventKind];
  }
  const words = kind.replace(/[_.]+/g, ' ').trim();
  return words.length === 0 ? kind : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The i18n message key for an event kind's plain name (C6-webhooks): `work.created` →
 * `WebhookEndpointsScreen.eventKind.work_created`. The screen resolves it with `useTOr`, falling back
 * to {@link webhookEventLabel} for a kind the catalog does not name yet, so Arabic shows Arabic and an
 * older kind still never shows a dotted code as its name.
 */
export function webhookEventMessageKey(kind: string): string {
  return `WebhookEndpointsScreen.eventKind.${kind.replace(/\./g, '_')}`;
}

/**
 * One webhook endpoint — paired Exact with the API's `WebhookEndpointView`. `organizationId` is
 * absent on both sides, and there is no `secret` field: the wire projection never echoes the tenant
 * id or the signing secret.
 */
export interface WebhookEndpointSummary {
  readonly id: string;
  readonly url: string;
  readonly eventKind: string;
  // ---- 0281 · R13 slice 2 ----
  readonly events: readonly string[];
  readonly description: string | null;
  readonly enabled: boolean;
  /** 'active' | 'paused' | 'needs_rotation'. */
  readonly status: string;
  readonly failureStreak: number;
  readonly pausedReason: string | null;
  readonly signingKeyId: string | null;
  readonly secretRotatedAt: string | null;
  readonly previousSecretExpiresAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The fields a register sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface RegisterWebhookInput {
  readonly url: string;
  readonly eventKind: WebhookEventKind;
  readonly secret: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/automations/webhooks`;
}

/** List the organization's webhook endpoints, newest first. */
export async function listWebhookEndpoints(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly WebhookEndpointSummary[]> {
  const { data } = await client.request<{ endpoints: readonly WebhookEndpointSummary[] }>({
    path: base(organizationSlug),
  });
  return data.endpoints;
}

/** Register a webhook endpoint. The secret is sent once and never returned. */
export async function registerWebhookEndpoint(
  client: ApiClient,
  organizationSlug: string,
  input: RegisterWebhookInput,
): Promise<WebhookEndpointSummary> {
  const { data } = await client.request<WebhookEndpointSummary>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Enable or disable an endpoint. */
export async function setWebhookEndpointEnabled(
  client: ApiClient,
  organizationSlug: string,
  id: string,
  enabled: boolean,
): Promise<WebhookEndpointSummary> {
  const { data } = await client.request<WebhookEndpointSummary>({
    method: 'PATCH',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
    body: { enabled },
  });
  return data;
}
