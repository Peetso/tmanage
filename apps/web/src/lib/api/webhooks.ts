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
 * One webhook endpoint — paired Exact with the API's `WebhookEndpointView`. `organizationId` is
 * absent on both sides, and there is no `secret` field: the wire projection never echoes the tenant
 * id or the signing secret.
 */
export interface WebhookEndpointSummary {
  readonly id: string;
  readonly url: string;
  readonly eventKind: string;
  readonly enabled: boolean;
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
