import type { ApiClient } from './client';

/**
 * 54-12 — the organization side of inbound e-mail, on the existing
 * `…/organizations/:orgSlug/inbound-email` routes. Hand-written mirrors of the API's
 * `InboundAddressView` and `InboundLogEntry`, narrowed to what the settings screen shows. The log
 * never carries a body; the address routes need `org.manage`, the log `client_request.triage`.
 */
export interface InboundAddress {
  readonly id: string;
  readonly address: string;
  readonly status: string;
  readonly defaultProjectId: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

export interface InboundLogEntry {
  readonly id: string;
  readonly fromEmail: string;
  readonly subject: string | null;
  readonly outcome: string;
  readonly outcomeReason: string | null;
  readonly receivedAt: string;
}

const base = (organizationSlug: string) =>
  `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbound-email`;

export async function getInboundAddress(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboundAddress | null> {
  const { data } = await client.request<{ address: InboundAddress | null }>({
    path: `${base(organizationSlug)}/address`,
  });
  return data.address;
}

export async function createInboundAddress(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboundAddress> {
  const { data } = await client.request<InboundAddress>({
    method: 'POST',
    path: `${base(organizationSlug)}/address`,
    body: {},
  });
  return data;
}

export async function rotateInboundAddress(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboundAddress> {
  const { data } = await client.request<InboundAddress>({
    method: 'POST',
    path: `${base(organizationSlug)}/address/rotate`,
  });
  return data;
}

export async function listInboundLog(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly InboundLogEntry[]> {
  const { data } = await client.request<{ entries: readonly InboundLogEntry[] }>({
    path: `${base(organizationSlug)}/log`,
  });
  return data.entries;
}
