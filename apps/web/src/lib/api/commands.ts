import type { ApiClient } from './client';

/**
 * SRCH command palette (x181) — the palette's contents.
 *
 * A single read the API serves at `GET .../search/commands?q=&limit?=`, behind the `search.use`
 * capability (the same coarse ceiling global search reads under). The list is a static, code-defined
 * command registry the server matches and orders; the client renders it and dispatches only what the
 * server returned. No write, no body: the inputs are query parameters.
 */

/** The kinds a command can be. Kept in lockstep with the API's `CommandKind`. */
export type CommandKind = 'navigate' | 'action';

/**
 * One command — paired Exact with the API's `CommandView` in the contracts gate. A `navigate`
 * command carries an `href` (an in-app route suffix) and a null `action`; an `action` command carries
 * an allowlisted `action` id and a null `href`. The shape is deliberately distinct from a
 * `SearchResult`: a command is a fixed navigation or quick action, never a row.
 */
export interface Command {
  readonly id: string;
  readonly title: string;
  readonly section: string;
  readonly kind: CommandKind;
  readonly href: string | null;
  readonly action: string | null;
}

export interface CommandQuery {
  readonly q?: string;
  readonly limit?: number;
}

export async function fetchCommands(
  client: ApiClient,
  organizationSlug: string,
  query: CommandQuery = {},
): Promise<readonly Command[]> {
  const parameters = new URLSearchParams();
  if (query.q) parameters.set('q', query.q);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const suffix = parameters.toString();
  const { data } = await client.request<{ commands: readonly Command[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/search/commands${
      suffix ? `?${suffix}` : ''
    }`,
  });
  return data.commands;
}
