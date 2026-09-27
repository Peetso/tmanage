import type { ApiClient } from './client';

/**
 * Inbox routing rules (module Inbox, x301) — the caller's own rules: list, add, remove, and resolve
 * the caller's notifications against them read-side. Behind `work.read` on the server (the same
 * internal-read capability the inbox and the per-member preferences reuse); a caller without it gets
 * the ordinary 403 the shared client turns into an error. The tenant is the slug in the path resolved
 * against the caller's membership, and the *member* is the authenticated principal — never a value
 * this client supplies — so it can only ever read or write the caller's own rules.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection so the
 * two shapes cannot drift.
 */

/** The notification field a rule matches on: the event `type` or the `object_type` it is about. */
export const INBOX_RULE_MATCH_TYPES = ['type', 'object_type'] as const;
export type InboxRuleMatchType = (typeof INBOX_RULE_MATCH_TYPES)[number];

/** The closed set of category labels a rule may apply; every saved category is validated against it. */
export const INBOX_RULE_CATEGORIES = ['urgent', 'follow_up', 'waiting', 'fyi', 'archive'] as const;
export type InboxRuleCategory = (typeof INBOX_RULE_CATEGORIES)[number];

/** One rule as the routes exchange it. Paired Exact with the API view. */
export interface InboxRuleView {
  readonly id: string;
  readonly matchType: InboxRuleMatchType;
  readonly matchValue: string;
  readonly category: InboxRuleCategory;
  readonly position: number;
}

/** The body POST accepts to add a rule. */
export interface NewInboxRule {
  readonly matchType: InboxRuleMatchType;
  readonly matchValue: string;
  readonly category: InboxRuleCategory;
  readonly position: number;
}

/** One candidate notification's resolved category: the first rule that fired, or null. */
export interface ResolvedCategory {
  readonly notificationId: string;
  readonly category: InboxRuleCategory | null;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/rules`;
}

export async function listInboxRules(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly InboxRuleView[]> {
  const { data } = await client.request<{ rules: readonly InboxRuleView[] }>({
    path: base(organizationSlug),
  });
  return data.rules;
}

export async function resolveInboxRules(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly ResolvedCategory[]> {
  const { data } = await client.request<{ resolved: readonly ResolvedCategory[] }>({
    path: `${base(organizationSlug)}/resolve`,
  });
  return data.resolved;
}

export async function createInboxRule(
  client: ApiClient,
  organizationSlug: string,
  rule: NewInboxRule,
): Promise<InboxRuleView> {
  const { data } = await client.request<InboxRuleView>({
    method: 'POST',
    path: base(organizationSlug),
    body: rule,
  });
  return data;
}

export async function deleteInboxRule(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}
