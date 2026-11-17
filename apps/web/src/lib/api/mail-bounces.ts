import type { ApiClient } from './client';

/**
 * 56-26 — an owner or admin checks one e-mail address against the company's stopped addresses
 * and starts sending to it again. Both calls are POST with the address in the body, so it never
 * appears in a URL or an access log. Behind `org.security.manage`; the server decides.
 */

/** One address as an admin sees it. Mirrors the API's `MailBounceStatus`. */
export interface MailBounceStatus {
  /** `suppressed` = TManage stopped sending to it; `bounced` = came back, still sending. */
  readonly status: 'clear' | 'bounced' | 'suppressed';
  /** `complaint` = the person marked the mail as spam (a feedback-loop report, 0370). */
  readonly lastKind: 'hard' | 'soft' | 'complaint' | null;
  /** The last delivery status code the mail server gave (`5.1.1`), when one was read. */
  readonly lastStatus: string | null;
  readonly lastBouncedAt: string | null;
  readonly suppressedAt: string | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/mail/bounces`;
}

/** `POST …/mail/bounces/status`: whether TManage stopped sending to `address`. */
export async function checkMailBounce(
  client: ApiClient,
  organizationSlug: string,
  address: string,
): Promise<MailBounceStatus> {
  const { data } = await client.request<MailBounceStatus>({
    method: 'POST',
    path: `${base(organizationSlug)}/status`,
    body: { address },
  });
  return data;
}

/** `POST …/mail/bounces/clear`: send to `address` again (it stops again on its own if mail keeps coming back). */
export async function clearMailBounce(
  client: ApiClient,
  organizationSlug: string,
  address: string,
): Promise<MailBounceStatus> {
  const { data } = await client.request<MailBounceStatus>({
    method: 'POST',
    path: `${base(organizationSlug)}/clear`,
    body: { address },
  });
  return data;
}
