/**
 * C25 (0317) — the "Which clients can see this?" rule, without storage. The table, the client
 * read predicate and the writes live in `work-item-client-audience.repository.ts`.
 */

/** The outcome of checking a requested client list against the project's client companies. */
export type ClientAudienceResolution =
  | {
      readonly ok: true;
      /** What to store: the listed companies, or `[]` when every project client is ticked. */
      readonly stored: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Validate a requested list of client companies for an item in a project shared with
 * `projectClientIds`. At least one must stay ticked, and every one must be a client of the
 * project. Ticking all of them stores no rows — "every client of the project", so a company
 * shared with the project later sees the item too, as it would have before C25.
 */
export function resolveClientAudience(
  requested: readonly string[],
  projectClientIds: readonly string[],
): ClientAudienceResolution {
  const unique = [...new Set(requested)];
  if (unique.length === 0) return { ok: false, message: 'choose at least one client' };
  const known = new Set(projectClientIds);
  if (unique.some((id) => !known.has(id))) {
    return { ok: false, message: 'must name clients of this project' };
  }
  return { ok: true, stored: unique.length === known.size ? [] : unique };
}
