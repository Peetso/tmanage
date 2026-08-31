import type { WorkItemState } from '@tmanage/domain';

/**
 * The cache keys for work items, in one place.
 *
 * ## Why this module exists
 *
 * Three screens ask the API for work items and two of them ask in different *shapes*: the
 * work list pages through `useInfiniteQuery`, whose cache entry is `{ pages, pageParams }`,
 * while the project overview and the request triage screen each hold one plain
 * `WorkItemSummary[]`. TanStack Query stores both under whatever key they name, and it does
 * not type-check that two callers naming the same key mean the same shape.
 *
 * They did name the same key. The project overview used
 * `['work-items', slug, projectId, '']`; the work list, with no state filter ticked, built
 * `['work-items', slug, projectId, [].sort().join(',')]` — which is the same key, because
 * joining an empty array gives the empty string. The overview's own "Update work" action
 * links straight to the list with `?project=`, so the two screens sat one click apart on a
 * client-side navigation that never remounts the `QueryClient`, and `staleTime` is 30
 * seconds. Whichever screen arrived second read the other's entry as fresh and used it
 * without refetching: the list did `data.pages.flat()` on an array and the overview did
 * `data.filter(...)` on `{ pages }`. Both throw, and the second screen renders as a blank
 * crash rather than as an error a person could act on.
 *
 * Naming the keys here fixes it by construction rather than by everyone remembering. Each
 * builder puts a **shape word** — `list`, `project` — in the key before anything a caller
 * chooses, so two different shapes cannot collide however the arguments line up. `all` stays
 * the shared prefix every write invalidates against, which is the one thing the three screens
 * genuinely do share.
 */
export const workItemKeys = {
  /**
   * The prefix a mutation invalidates: every work-item query in this organization, whatever
   * its shape. TanStack matches keys by prefix, so this reaches both builders below.
   */
  all: (organizationSlug: string) => ['work-items', organizationSlug] as const,

  /** The paged list — an infinite query, so its cache entry is `{ pages, pageParams }`. */
  list: (organizationSlug: string, projectId: string, states: readonly WorkItemState[]) =>
    ['work-items', organizationSlug, 'list', projectId, [...states].sort().join(',')] as const,

  /** One project's work, as a single array. Used by the overview and by triage. */
  project: (organizationSlug: string, projectId: string) =>
    ['work-items', organizationSlug, 'project', projectId] as const,
};
