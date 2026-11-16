/**
 * 56-07p — the workspace's public link manager (Settings · Public links): the limits and the
 * request validation the API applies and the web screen builds against, in one place.
 *
 * Pure: no I/O, no clock of its own (every check that needs "now" is handed it).
 */

/** Rows per page on the manager list. */
export const PUBLIC_LINK_MANAGER_PAGE_SIZE = 25;
/** The most links one bulk revoke or expiry change may name. */
export const PUBLIC_LINK_BULK_MAX = 100;
/** A link may end at most this many days from now — the same ceiling as issuing one. */
export const PUBLIC_LINK_MAX_EXPIRY_DAYS = 30;
/** A live link that ends within this many days reads "Ending soon". */
export const PUBLIC_LINK_ENDING_SOON_DAYS = 3;
/** The longest search text the list accepts. */
export const PUBLIC_LINK_SEARCH_MAX = 100;

export const PUBLIC_LINK_STATE_FILTERS = ['active', 'ending_soon', 'ended', 'all'] as const;
export type PublicLinkStateFilter = (typeof PUBLIC_LINK_STATE_FILTERS)[number];

/** What a row shows as its state. "used" = a use-limited link used up; "answered" = decided. */
export type PublicLinkManagedStatus =
  'active' | 'ending_soon' | 'used' | 'answered' | 'expired' | 'revoked';

export interface PublicLinkManagerQuery {
  readonly search: string | null;
  readonly kind: string | null;
  readonly createdBy: string | null;
  readonly state: PublicLinkStateFilter;
  readonly page: number;
}

export type PublicLinkParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly field: string; readonly message: string };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DAY_MS = 86_400_000;

const ok = <T>(value: T): PublicLinkParse<T> => ({ ok: true, value });
const refuse = (field: string, message: string): PublicLinkParse<never> => ({
  ok: false,
  field,
  message,
});

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The list's query string. `kinds` are the kinds this workspace's links can have. */
export function parsePublicLinkManagerQuery(
  raw: Readonly<Record<string, unknown>>,
  kinds: readonly string[],
): PublicLinkParse<PublicLinkManagerQuery> {
  const search = optionalText(raw['q']);
  if (search !== null && search.length > PUBLIC_LINK_SEARCH_MAX) {
    return refuse('q', `is over ${PUBLIC_LINK_SEARCH_MAX} characters`);
  }
  const kind = optionalText(raw['kind']);
  if (kind !== null && !kinds.includes(kind)) return refuse('kind', 'is not a link kind');
  const createdBy = optionalText(raw['createdBy']);
  if (createdBy !== null && !UUID_SHAPE.test(createdBy)) {
    return refuse('createdBy', 'must be a UUID');
  }
  const stateText = optionalText(raw['state']) ?? 'active';
  const state = PUBLIC_LINK_STATE_FILTERS.find((s) => s === stateText);
  if (state === undefined) {
    return refuse('state', `must be one of ${PUBLIC_LINK_STATE_FILTERS.join(', ')}`);
  }
  const pageText = optionalText(raw['page']) ?? '1';
  const page = /^\d{1,6}$/u.test(pageText) ? Number(pageText) : 0;
  if (page < 1) return refuse('page', 'must be a whole number from 1');
  return ok({ search, kind, createdBy, state, page });
}

/** `{ linkIds: [...] }`: 1 to {@link PUBLIC_LINK_BULK_MAX} distinct link ids. */
export function parsePublicLinkIds(raw: unknown): PublicLinkParse<readonly string[]> {
  const ids = (raw ?? {}) as Readonly<Record<string, unknown>>;
  const list = ids['linkIds'];
  if (!Array.isArray(list) || list.length === 0 || list.length > PUBLIC_LINK_BULK_MAX) {
    return refuse('linkIds', `must list 1 to ${PUBLIC_LINK_BULK_MAX} links`);
  }
  if (!list.every((id): id is string => typeof id === 'string' && UUID_SHAPE.test(id))) {
    return refuse('linkIds', 'must be link ids');
  }
  return ok([...new Set(list)]);
}

/**
 * `{ linkIds, expiresAt }`: the new end, an ISO instant after `now` and no later than
 * {@link PUBLIC_LINK_MAX_EXPIRY_DAYS} days (plus the rest of that last day) from it.
 */
export function parsePublicLinkExpiry(
  raw: unknown,
  now: Date,
): PublicLinkParse<{ readonly linkIds: readonly string[]; readonly expiresAt: Date }> {
  const ids = parsePublicLinkIds(raw);
  if (!ids.ok) return ids;
  const value = ((raw ?? {}) as Readonly<Record<string, unknown>>)['expiresAt'];
  const at = typeof value === 'string' ? new Date(value) : null;
  if (at === null || Number.isNaN(at.getTime())) {
    return refuse('expiresAt', 'must be a date and time');
  }
  if (at.getTime() <= now.getTime()) return refuse('expiresAt', 'must be in the future');
  if (at.getTime() > now.getTime() + (PUBLIC_LINK_MAX_EXPIRY_DAYS + 1) * DAY_MS) {
    return refuse('expiresAt', `must be within ${PUBLIC_LINK_MAX_EXPIRY_DAYS} days`);
  }
  return ok({ linkIds: ids.value, expiresAt: at });
}

/** The state a row shows, from the stored columns. */
export function publicLinkManagedStatus(
  row: {
    readonly revokedAt: Date | null;
    readonly decision: string | null;
    readonly expiresAt: Date;
    readonly maxUses: number | null;
    readonly uses: number;
  },
  now: Date,
): PublicLinkManagedStatus {
  if (row.revokedAt !== null) return 'revoked';
  if (row.decision !== null) return 'answered';
  if (row.maxUses !== null && row.uses >= row.maxUses) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  return row.expiresAt.getTime() <= now.getTime() + PUBLIC_LINK_ENDING_SOON_DAYS * DAY_MS
    ? 'ending_soon'
    : 'active';
}

/** A link that can still be opened: only these can be revoked or given a new end. */
export function publicLinkIsLive(status: PublicLinkManagedStatus): boolean {
  return status === 'active' || status === 'ending_soon';
}
