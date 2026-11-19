import { boundedInteger } from './settings.service.js';

/**
 * 62-A3 (B14) — the platform's own monthly running costs, typed by a platform admin in Platform
 * settings so the Growth page can show the cost per active company: AI spend (from the ledger)
 * plus these. Stored as one `platform_settings` row (`growth_unit_costs`, JSON of whole US cents a
 * month). No row means "not set": the Growth page then says so and never shows 0 in its place.
 */

export const UNIT_COSTS_SETTING = 'growth_unit_costs';

/** At most 100 000 USD a month per line: a typo guard, not a business rule. */
export const UNIT_COST_MAX_CENTS = 10_000_000;

export interface UnitCosts {
  /** Hosting, database and file storage, per month. */
  readonly hostingCentsPerMonth: number;
  /** Outgoing mail, per month. */
  readonly mailCentsPerMonth: number;
}

/** The two lines, summed: what the platform costs to run in a month before AI. */
export function monthlyUnitCostCents(costs: UnitCosts): number {
  return costs.hostingCentsPerMonth + costs.mailCentsPerMonth;
}

const isCents = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= UNIT_COST_MAX_CENTS;

/**
 * The stored value, or `null` when unset. A row that does not parse to both lines is treated as
 * unset as well (the page says "not set"), never as zero.
 */
export function parseStoredUnitCosts(stored: string | null | undefined): UnitCosts | null {
  if (stored === null || stored === undefined || stored.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const hosting = record['hostingCentsPerMonth'];
  const mail = record['mailCentsPerMonth'];
  return isCents(hosting) && isCents(mail)
    ? { hostingCentsPerMonth: hosting, mailCentsPerMonth: mail }
    : null;
}

/** The PUT body: both lines, whole cents, 0 only when typed. */
export function parseUnitCostsBody(body: Readonly<Record<string, unknown>> | null): UnitCosts {
  return {
    hostingCentsPerMonth: boundedInteger(
      body?.['hostingCentsPerMonth'],
      'hostingCentsPerMonth',
      0,
      UNIT_COST_MAX_CENTS,
    ),
    mailCentsPerMonth: boundedInteger(
      body?.['mailCentsPerMonth'],
      'mailCentsPerMonth',
      0,
      UNIT_COST_MAX_CENTS,
    ),
  };
}

export function serializeUnitCosts(costs: UnitCosts): string {
  return JSON.stringify({
    hostingCentsPerMonth: costs.hostingCentsPerMonth,
    mailCentsPerMonth: costs.mailCentsPerMonth,
  });
}
