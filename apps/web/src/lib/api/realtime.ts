import type { ApiClient } from './client';

/**
 * RT-001's mint. The socket URL travels with the ticket because it is a deployment fact
 * the API knows and the browser must not guess: `null` means this deployment runs no live
 * socket (the worker is controlled batches), and the screen keeps its reload behaviour.
 */
export interface RealtimeTicket {
  readonly ticket: string;
  readonly expiresAt: string;
  readonly socketUrl: string | null;
}

export async function mintRealtimeTicket(
  client: ApiClient,
  organizationSlug: string,
): Promise<RealtimeTicket> {
  const { data } = await client.request<RealtimeTicket>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/realtime/tickets`,
  });
  return data;
}
