/**
 * 52-04 — hourly sell-rate resolution (pure, no I/O).
 *
 * An organization keeps rate cards at three scopes: one `org` card (the default rate, rates by role
 * and by person), `client` cards (overrides for one client organization) and `project` cards (an
 * override for one project; a project may also be pointed at any card through
 * `projects.rate_card_id`). Every entry carries an effective window `effective_from <= on <
 * effective_to` (`effective_to` NULL = open-ended), so changing a rate never rewrites history.
 *
 * Resolution order: **project → client → membership → role → org default**. Inside a project or
 * client card the most specific entry wins (membership, then role, then the card's default); on the
 * org card the person's entry, then the role's, then the default. The first hit is the rate. No hit
 * is `null` — never 0, so an unpriced hour is visibly unpriced rather than free.
 */

export const RATE_CARD_SCOPES = ['org', 'client', 'project'] as const;
export type RateCardScope = (typeof RATE_CARD_SCOPES)[number];
export const RATE_TARGET_TYPES = ['default', 'role', 'membership', 'service'] as const;
export type RateTargetType = (typeof RATE_TARGET_TYPES)[number];
export type RateSource = 'project' | 'client' | 'membership' | 'role' | 'default';

export interface RateEntryInput {
  readonly targetType: RateTargetType;
  /** Role key, membership id or service code; `null` for `default`. */
  readonly targetKey: string | null;
  readonly hourlyMinor: number;
  /** `YYYY-MM-DD`. */
  readonly effectiveFrom: string;
  /** `YYYY-MM-DD`, exclusive; `null` = open-ended. */
  readonly effectiveTo: string | null;
}

export interface RateCardInput {
  readonly id: string;
  readonly scope: RateCardScope;
  readonly scopeId: string | null;
  readonly currency: string;
  readonly archived: boolean;
  readonly entries: readonly RateEntryInput[];
}

export interface RateQuery {
  readonly projectId: string | null;
  readonly clientOrgId: string | null;
  readonly membershipId: string | null;
  readonly role: string | null;
  /** `YYYY-MM-DD` — the day the hour was worked. */
  readonly on: string;
  /** `projects.rate_card_id`: when set, that card is the project's card. */
  readonly projectRateCardId?: string | null;
}

export interface ResolvedRate {
  readonly hourlyMinor: number;
  readonly currency: string;
  readonly source: RateSource;
  readonly rateCardId: string;
}

/** Does the window `[from, to)` contain the day? ISO dates compare as strings. */
export function rateWindowContains(
  window: { readonly effectiveFrom: string; readonly effectiveTo: string | null },
  on: string,
): boolean {
  return window.effectiveFrom <= on && (window.effectiveTo === null || on < window.effectiveTo);
}

/** Do two windows share at least one day? */
export function rateWindowsOverlap(
  a: { readonly effectiveFrom: string; readonly effectiveTo: string | null },
  b: { readonly effectiveFrom: string; readonly effectiveTo: string | null },
): boolean {
  const aBeforeB = a.effectiveTo !== null && a.effectiveTo <= b.effectiveFrom;
  const bBeforeA = b.effectiveTo !== null && b.effectiveTo <= a.effectiveFrom;
  return !aBeforeB && !bBeforeA;
}

function entryFor(
  card: RateCardInput,
  targetType: RateTargetType,
  targetKey: string | null,
  on: string,
): RateEntryInput | null {
  if (targetType !== 'default' && targetKey === null) return null;
  let best: RateEntryInput | null = null;
  for (const entry of card.entries) {
    if (entry.targetType !== targetType) continue;
    if (targetType !== 'default' && entry.targetKey !== targetKey) continue;
    if (!rateWindowContains(entry, on)) continue;
    if (best === null || entry.effectiveFrom > best.effectiveFrom) best = entry;
  }
  return best;
}

function mostSpecific(card: RateCardInput, query: RateQuery): RateEntryInput | null {
  return (
    entryFor(card, 'membership', query.membershipId, query.on) ??
    entryFor(card, 'role', query.role, query.on) ??
    entryFor(card, 'default', null, query.on)
  );
}

function hit(card: RateCardInput, entry: RateEntryInput | null, source: RateSource) {
  return entry === null
    ? null
    : { hourlyMinor: entry.hourlyMinor, currency: card.currency, source, rateCardId: card.id };
}

export function resolveRate(
  cards: readonly RateCardInput[],
  query: RateQuery,
): ResolvedRate | null {
  const live = cards.filter((card) => !card.archived);
  const projectCard =
    (query.projectRateCardId
      ? live.find((card) => card.id === query.projectRateCardId)
      : undefined) ??
    (query.projectId === null
      ? undefined
      : live.find((card) => card.scope === 'project' && card.scopeId === query.projectId));
  if (projectCard) {
    const found = hit(projectCard, mostSpecific(projectCard, query), 'project');
    if (found) return found;
  }
  const clientCard =
    query.clientOrgId === null
      ? undefined
      : live.find((card) => card.scope === 'client' && card.scopeId === query.clientOrgId);
  if (clientCard && clientCard !== projectCard) {
    const found = hit(clientCard, mostSpecific(clientCard, query), 'client');
    if (found) return found;
  }
  const orgCard = live.find((card) => card.scope === 'org');
  if (!orgCard) return null;
  return (
    hit(orgCard, entryFor(orgCard, 'membership', query.membershipId, query.on), 'membership') ??
    hit(orgCard, entryFor(orgCard, 'role', query.role, query.on), 'role') ??
    hit(orgCard, entryFor(orgCard, 'default', null, query.on), 'default')
  );
}

/** The cost rate in force on a day, from a member's windows; `null` when none applies. */
export function resolveCostRate<
  T extends { readonly effectiveFrom: string; readonly effectiveTo: string | null },
>(windows: readonly T[], on: string): T | null {
  let best: T | null = null;
  for (const window of windows) {
    if (!rateWindowContains(window, on)) continue;
    if (best === null || window.effectiveFrom > best.effectiveFrom) best = window;
  }
  return best;
}
