import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';

/**
 * 57-17 WTP — the pure rules of the willingness-to-pay card: who may see and answer it, when,
 * and what an answer may hold. Every one is checked on the server; the web card only draws.
 */

/** The price bands, per person per month, in the card's order. */
export const PRICING_BANDS = ['nothing', 'under_5', '5_9', '10_15', 'over_15'] as const;
export type PricingBand = (typeof PRICING_BANDS)[number];

export type PricingSurveyOutcome = 'answered' | 'skipped';

/** The card shows only after this many days of workspace use (from the workspace's creation). */
export const PRICING_SURVEY_MIN_DAYS = 14;

/** The free-text note's cap, in characters (the column is VARCHAR(500)). */
export const PRICING_SURVEY_NOTE_MAX = 500;

/**
 * The roles that own the price decision: the workspace owner and its admins. Everyone else —
 * members, managers, guests, every client role and the hidden Support-session role — never sees
 * the card and is refused on the write.
 */
export const PRICING_SURVEY_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'org_admin',
  'workspace_admin',
]);

export function mayAnswerPricingSurvey(principal: Principal): boolean {
  return (
    principal.kind === 'internal' &&
    principal.membershipStatus === 'active' &&
    PRICING_SURVEY_ROLES.has(principal.role)
  );
}

/** Has the workspace been in use for at least {@link PRICING_SURVEY_MIN_DAYS} days at `now`? */
export function workspaceOldEnough(createdAt: Date | null, now: Date): boolean {
  if (createdAt === null || Number.isNaN(createdAt.getTime())) return false;
  return now.getTime() - createdAt.getTime() >= PRICING_SURVEY_MIN_DAYS * 24 * 60 * 60 * 1000;
}

export function isPricingBand(value: unknown): value is PricingBand {
  return typeof value === 'string' && (PRICING_BANDS as readonly string[]).includes(value);
}

export interface PricingAnswerInput {
  readonly band: PricingBand;
  readonly note: string | null;
}

/** Validate an answer body: a known band, and an optional note within the cap (400 otherwise). */
export function parsePricingAnswer(body: unknown): PricingAnswerInput {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const problems: { field: string; message: string }[] = [];
  if (!isPricingBand(raw['band'])) {
    problems.push({ field: 'band', message: `must be one of ${PRICING_BANDS.join(', ')}` });
  }
  const rawNote = raw['note'];
  let note: string | null = null;
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== 'string') {
      problems.push({ field: 'note', message: 'must be text' });
    } else {
      const trimmed = rawNote.trim();
      if ([...trimmed].length > PRICING_SURVEY_NOTE_MAX) {
        problems.push({
          field: 'note',
          message: `must be at most ${String(PRICING_SURVEY_NOTE_MAX)} characters`,
        });
      } else {
        note = trimmed === '' ? null : trimmed;
      }
    }
  }
  if (problems.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', problems);
  }
  return { band: raw['band'] as PricingBand, note };
}
