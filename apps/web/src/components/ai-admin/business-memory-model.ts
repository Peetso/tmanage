import type { BusinessFactView } from '../../lib/api/business-memory';

/**
 * Business Memory's functional core (IP-3): the filter chips, their counts and the order of the
 * list. Pure, so the screen only draws; every status and the `stale` flag come from the API.
 */

export type FactFilter = 'all' | 'waiting' | 'check' | 'retired';
export const FACT_FILTERS: readonly FactFilter[] = ['all', 'waiting', 'check', 'retired'];

/** The page size of the list and of each "Show 10 more" (Figma 788:49677). */
export const FACT_PAGE = 10;

export function inFilter(fact: BusinessFactView, filter: FactFilter): boolean {
  switch (filter) {
    case 'all':
      return fact.status !== 'retired';
    case 'waiting':
      return fact.status === 'proposed';
    case 'check':
      return fact.status === 'approved' && fact.stale;
    case 'retired':
      return fact.status === 'retired';
  }
}

export function filterCounts(facts: readonly BusinessFactView[]): Record<FactFilter, number> {
  const counts: Record<FactFilter, number> = { all: 0, waiting: 0, check: 0, retired: 0 };
  for (const fact of facts) {
    for (const filter of FACT_FILTERS) if (inFilter(fact, filter)) counts[filter] += 1;
  }
  return counts;
}

/** What a row shows in its capsule, and so which decisions it offers. */
export type FactState = 'waiting' | 'check' | 'approved' | 'retired';

export function factState(fact: BusinessFactView): FactState {
  if (fact.status === 'proposed') return 'waiting';
  if (fact.status === 'retired') return 'retired';
  return fact.stale ? 'check' : 'approved';
}

const ORDER: Record<FactState, number> = { waiting: 0, check: 1, approved: 2, retired: 3 };

/** Decisions first (waiting, then needs a check), then the newest change. */
export function sortFacts(facts: readonly BusinessFactView[]): BusinessFactView[] {
  return [...facts].sort(
    (a, b) => ORDER[factState(a)] - ORDER[factState(b)] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** Whole months between two instants (a fact last checked 7 months ago says "7 months"). */
export function monthsBetween(fromIso: string, to: Date): number {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return 0;
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** The fact's length as the API counts it (code points), for the "34 of 500" counter. */
export function factLength(text: string): number {
  return [...text].length;
}
