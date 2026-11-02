import { RATE_CARD_SCOPES, RATE_TARGET_TYPES, rateWindowsOverlap } from '@tmanage/domain';
import type { RateCardScope, RateTargetType } from '@tmanage/domain';
import { currency, invalid, wholeNumber } from './finance-rules.js';

/**
 * 52-04 — the pure half of the rates module: body validation for cards, entries, cost rates,
 * re-price and project assignment, and the overlap rule. No I/O here.
 */

/** 0 .. 100,000,000 minor units an hour (1,000,000.00 in a two-digit currency). */
export const MAX_HOURLY_MINOR = 100_000_000;
/** Re-price touches at most this many entries in one call. */
export const MAX_REPRICE_ROWS = 5_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const KEY = /^[A-Za-z0-9:_.-]{1,64}$/u;

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('body', 'must be an object');
  }
  return body as Record<string, unknown>;
}

export function isoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value))
    throw invalid(field, 'must be YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw invalid(field, 'is not a real date');
  }
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) {
    throw invalid('name', 'must be 1 to 120 characters');
  }
  return value.trim();
}

function window(input: Record<string, unknown>): {
  effectiveFrom: string;
  effectiveTo: string | null;
} {
  const effectiveFrom = isoDate(input['effectiveFrom'], 'effectiveFrom');
  const rawTo = input['effectiveTo'];
  const effectiveTo = rawTo === undefined || rawTo === null ? null : isoDate(rawTo, 'effectiveTo');
  if (effectiveTo !== null && effectiveTo <= effectiveFrom) {
    throw invalid('effectiveTo', 'must be after effectiveFrom');
  }
  return { effectiveFrom, effectiveTo };
}

export interface RateCardInputBody {
  readonly scope: RateCardScope;
  readonly scopeId: string | null;
  readonly name: string;
  readonly currency: string;
}

export function validateRateCard(body: unknown): RateCardInputBody {
  const input = record(body);
  const scope = RATE_CARD_SCOPES.find((s) => s === input['scope']);
  if (scope === undefined) throw invalid('scope', `must be one of ${RATE_CARD_SCOPES.join(', ')}`);
  const rawScopeId = input['scopeId'];
  let scopeId: string | null = null;
  if (scope === 'org') {
    if (rawScopeId !== undefined && rawScopeId !== null)
      throw invalid('scopeId', 'must be empty for org');
  } else {
    if (typeof rawScopeId !== 'string' || rawScopeId.length === 0 || rawScopeId.length > 36) {
      throw invalid('scopeId', 'is required for a client or project card');
    }
    scopeId = rawScopeId;
  }
  return {
    scope,
    scopeId,
    name: name(input['name']),
    currency: currency(input['currency'], 'currency'),
  };
}

export interface RateCardUpdateBody {
  readonly name?: string;
  readonly archived?: boolean;
}

export function validateRateCardUpdate(body: unknown): RateCardUpdateBody {
  const input = record(body);
  const archived = input['archived'];
  if (archived !== undefined && typeof archived !== 'boolean') {
    throw invalid('archived', 'must be true or false');
  }
  return {
    ...(input['name'] === undefined ? {} : { name: name(input['name']) }),
    ...(archived === undefined ? {} : { archived }),
  };
}

export interface RateEntryBody {
  readonly targetType: RateTargetType;
  readonly targetKey: string | null;
  readonly hourlyMinor: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export function validateRateEntry(body: unknown): RateEntryBody {
  const input = record(body);
  const targetType = RATE_TARGET_TYPES.find((t) => t === input['targetType']);
  if (targetType === undefined) {
    throw invalid('targetType', `must be one of ${RATE_TARGET_TYPES.join(', ')}`);
  }
  const rawKey = input['targetKey'];
  let targetKey: string | null = null;
  if (targetType === 'default') {
    if (rawKey !== undefined && rawKey !== null)
      throw invalid('targetKey', 'must be empty for default');
  } else {
    if (typeof rawKey !== 'string' || !KEY.test(rawKey)) throw invalid('targetKey', 'is required');
    targetKey = rawKey;
  }
  return {
    targetType,
    targetKey,
    hourlyMinor: wholeNumber(input['hourlyMinor'], 'hourlyMinor', 0, MAX_HOURLY_MINOR),
    ...window(input),
  };
}

export interface CostRateBody {
  readonly hourlyCostMinor: number;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export function validateCostRate(body: unknown): CostRateBody {
  const input = record(body);
  return {
    hourlyCostMinor: wholeNumber(input['hourlyCostMinor'], 'hourlyCostMinor', 0, MAX_HOURLY_MINOR),
    currency: currency(input['currency'], 'currency'),
    ...window(input),
  };
}

export interface RepriceBody {
  readonly projectId: string | 'all';
  readonly until: string;
}

export function validateReprice(body: unknown): RepriceBody {
  const input = record(body);
  const projectId = input['projectId'];
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 36) {
    throw invalid('projectId', "must be a project id or 'all'");
  }
  return { projectId, until: isoDate(input['until'], 'until') };
}

export interface AssignBody {
  readonly projectId: string;
  readonly rateCardId: string | null;
  readonly billableDefault?: boolean;
}

export function validateAssign(body: unknown): AssignBody {
  const input = record(body);
  const projectId = input['projectId'];
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 36) {
    throw invalid('projectId', 'is required');
  }
  const rateCardId = input['rateCardId'];
  if (rateCardId !== null && (typeof rateCardId !== 'string' || rateCardId.length > 36)) {
    throw invalid('rateCardId', 'must be a rate card id or null');
  }
  const billableDefault = input['billableDefault'];
  if (billableDefault !== undefined && typeof billableDefault !== 'boolean') {
    throw invalid('billableDefault', 'must be true or false');
  }
  return {
    projectId,
    rateCardId,
    ...(billableDefault === undefined ? {} : { billableDefault }),
  };
}

/** Refuse a window that shares a day with another window of the same target. */
export function assertNoOverlap(
  existing: readonly { readonly effectiveFrom: string; readonly effectiveTo: string | null }[],
  next: { readonly effectiveFrom: string; readonly effectiveTo: string | null },
): void {
  if (existing.some((row) => rateWindowsOverlap(row, next))) {
    throw invalid('effectiveFrom', 'overlaps another rate for the same target');
  }
}

/** Cost amounts never enter the audit trail: the change is recorded, the value redacted. */
export const REDACTED = '[redacted]';
