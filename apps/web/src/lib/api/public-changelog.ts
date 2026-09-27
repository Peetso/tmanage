import type { ApiClient } from './client';

/**
 * Public product changelog (x160) — the read-only public changelog.
 *
 * The API serves it at `GET /v1/public/site/changelog` as a `@Public()` route: no session, no
 * tenant, no capability. This helper therefore calls with `authentication: 'none'` — it is
 * marketing-site content a prospective customer reads before they have an account, so there is no
 * session to send and a 401-driven refresh would make no sense. There is no organization slug and no
 * query: the response is the published entries, newest first, grouped by month.
 */

/** The three categories an entry may carry. Not exported: the screen reads it through the view. */
type ChangelogCategory = 'feature' | 'fix' | 'security';

/**
 * One published entry. Not exported: the contracts gate enumerates every exported response shape in
 * this folder, and the changelog is a single paired response (`PublicChangelogView`); the screen
 * reaches an entry through indexed access, not a second projection.
 */
interface PublicChangelogEntry {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** The entry body as Markdown source. */
  readonly bodyMd: string;
  readonly category: ChangelogCategory;
  /** An ISO-8601 instant on the wire — when the entry went live. */
  readonly publishedAt: string;
}

/** One month bucket: its `YYYY-MM` month (UTC) and the entries published in it. Not exported (see above). */
interface PublicChangelogMonth {
  readonly month: string;
  readonly entries: readonly PublicChangelogEntry[];
}

/** The changelog read's response — paired Exact with the API's `PublicChangelogView` in the contracts gate. */
export interface PublicChangelogView {
  readonly months: readonly PublicChangelogMonth[];
}

/** One month, for the screen — an indexed access, so it is not a second enumerated shape. */
export type PublicChangelogMonthRow = PublicChangelogView['months'][number];

export async function getPublicChangelog(client: ApiClient): Promise<PublicChangelogView> {
  const { data } = await client.request<PublicChangelogView>({
    path: '/v1/public/site/changelog',
    authentication: 'none',
  });
  return data;
}
