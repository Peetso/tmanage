import type { ApiClient } from './client';

/**
 * PERSONMAIL (ADR-0013) — the page behind every mail's "Unsubscribe" link. It posts the SAME signed
 * token to the SAME RFC 8058 one-click route a mail client posts to (`POST
 * /v1/public/email/unsubscribe?t=…`); there is no second unsubscribe mechanism. The token is in
 * the query string by the RFC's design and holds an address hash, never the address. 400 means the
 * link is not valid.
 */
export async function unsubscribeByToken(client: ApiClient, token: string): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `/v1/public/email/unsubscribe?t=${encodeURIComponent(token)}`,
    authentication: 'none',
  });
}
