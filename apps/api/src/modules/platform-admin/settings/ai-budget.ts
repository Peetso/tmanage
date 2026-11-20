import { ApiError } from '../../../common/http/errors.js';
import { platformSettingsReader } from '../../billing/platform-settings-reader.js';
import type { PlatformSettingsReader } from '../../billing/platform-settings-reader.js';
import type { AiBudgetSettings, AiBudgetSettingsSource } from '../../copilot/ai-budget.service.js';
import { platformCapMicroUsd, poolCapsMicroUsd, type AiPool } from '../../copilot/ai-tiers.js';
import { boundedInteger } from './settings.service.js';

/**
 * 62-08 (plan 62 §5) — the platform admin's AI budget settings: the monthly caps of the customers,
 * testing and reserve pools, the Sonnet switch and the standing pause. Stored as one
 * `platform_settings` row (`ai_budget`, JSON). This file is the one place that reads and checks
 * that row (AR-8); the budget service gets it through {@link AiBudgetSettings} (IP-6).
 *
 * The three caps together never pass the server's ceiling `AI_PLATFORM_CAP_MAX_USD` (the env is
 * the hard limit a database row cannot raise): a body above it is refused (400
 * `ai_cap_above_ceiling`), and a stored row above it — the env was lowered later — is read as the
 * default split of the ceiling instead (fail safe, never above). The packs pool is not set here:
 * it grows only by the cost value of packs actually paid (plan §5, phase 6).
 */

export const AI_BUDGET_SETTING = 'ai_budget';

/** When a cap change takes effect: on this month's pool rows now, or from next month's rows. */
export const AI_BUDGET_APPLY_TO = ['this_month', 'next_month'] as const;
export type AiBudgetApplyTo = (typeof AI_BUDGET_APPLY_TO)[number];

/** The pools whose cap the platform admin sets. */
export const AI_ADMIN_POOLS = ['customers', 'testing', 'reserve'] as const;
export type AiAdminPool = (typeof AI_ADMIN_POOLS)[number];

const MICRO_USD_PER_CENT = 10_000;

export interface AiBudgetConfig {
  readonly capsMicroUsd: Readonly<Record<AiAdminPool, number>>;
  readonly sonnetEnabled: boolean;
  /** A standing pause from the platform admin: no model call until resumed (any month). */
  readonly paused: boolean;
}

/** The env split of the ceiling (60 / 25 / 15), Sonnet on, not paused. */
export function defaultAiBudgetConfig(ceilingMicroUsd: number): AiBudgetConfig {
  const caps = poolCapsMicroUsd(ceilingMicroUsd);
  return {
    capsMicroUsd: { customers: caps.customers, testing: caps.testing, reserve: caps.reserve },
    sonnetEnabled: true,
    paused: false,
  };
}

export function capsTotalMicroUsd(caps: Readonly<Record<AiAdminPool, number>>): number {
  return caps.customers + caps.testing + caps.reserve;
}

const isMicroUsd = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * The stored row, checked against the ceiling in force. No row, or one that does not parse, is
 * the default; caps that sum above the ceiling fall back to the default caps but keep the
 * switches (a pause is never lost to a lowered env).
 */
export function parseStoredAiBudget(
  stored: string | null | undefined,
  ceilingMicroUsd: number,
): AiBudgetConfig {
  const fallback = defaultAiBudgetConfig(ceilingMicroUsd);
  if (stored === null || stored === undefined || stored.trim() === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;
  const sonnetEnabled = record['sonnetEnabled'] !== false;
  const paused = record['paused'] === true;
  const caps = {
    customers: record['customersMicroUsd'],
    testing: record['testingMicroUsd'],
    reserve: record['reserveMicroUsd'],
  };
  const valid =
    isMicroUsd(caps.customers) &&
    isMicroUsd(caps.testing) &&
    isMicroUsd(caps.reserve) &&
    caps.customers + caps.testing + caps.reserve <= ceilingMicroUsd;
  const storedCaps = valid
    ? {
        customers: caps.customers as number,
        testing: caps.testing as number,
        reserve: caps.reserve as number,
      }
    : fallback.capsMicroUsd;
  return {
    capsMicroUsd: storedCaps,
    sonnetEnabled,
    paused,
  };
}

/** The stored shape of the row (also the audit's before/after). */
export function aiBudgetRecord(config: AiBudgetConfig): Readonly<Record<string, number | boolean>> {
  return {
    customersMicroUsd: config.capsMicroUsd.customers,
    testingMicroUsd: config.capsMicroUsd.testing,
    reserveMicroUsd: config.capsMicroUsd.reserve,
    sonnetEnabled: config.sonnetEnabled,
    paused: config.paused,
  };
}

export function serializeAiBudget(config: AiBudgetConfig): string {
  return JSON.stringify(aiBudgetRecord(config));
}

export interface AiBudgetUpdate {
  readonly capsMicroUsd: Readonly<Record<AiAdminPool, number>>;
  readonly sonnetEnabled: boolean;
  readonly applyTo: AiBudgetApplyTo;
}

/**
 * The PUT body (IP-2): three caps in whole US cents, the Sonnet switch and when the caps apply.
 * The caps' sum above the ceiling is refused here, before anything is written.
 */
export function parseAiBudgetBody(
  body: Readonly<Record<string, unknown>> | null,
  ceilingMicroUsd: number,
): AiBudgetUpdate {
  const maxCents = Math.floor(ceilingMicroUsd / MICRO_USD_PER_CENT);
  const cents = (field: string) => boundedInteger(body?.[field], field, 0, maxCents);
  const capsMicroUsd = {
    customers: cents('customersCents') * MICRO_USD_PER_CENT,
    testing: cents('testingCents') * MICRO_USD_PER_CENT,
    reserve: cents('reserveCents') * MICRO_USD_PER_CENT,
  };
  const sonnet = body?.['sonnetEnabled'];
  if (typeof sonnet !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'Choose whether Sonnet stays on.', [
      { field: 'sonnetEnabled', message: 'must be true or false' },
    ]);
  }
  const applyTo = body?.['applyTo'];
  if (!(AI_BUDGET_APPLY_TO as readonly unknown[]).includes(applyTo)) {
    throw new ApiError(400, 'validation_failed', 'Choose this month or next month.', [
      { field: 'applyTo', message: 'must be this_month or next_month' },
    ]);
  }
  if (capsTotalMicroUsd(capsMicroUsd) > ceilingMicroUsd) {
    throw new ApiError(
      400,
      'validation_failed',
      `The three pools together must stay within the platform ceiling of ${usd(ceilingMicroUsd)}.`,
      [{ field: 'customersCents', message: 'sum above AI_PLATFORM_CAP_MAX_USD' }],
      'ai_cap_above_ceiling',
    );
  }
  return { capsMicroUsd, sonnetEnabled: sonnet, applyTo: applyTo as AiBudgetApplyTo };
}

/** The reserve release body (IP-2): whole cents into the customers or testing pool. */
export function parseReserveRelease(
  body: Readonly<Record<string, unknown>> | null,
  ceilingMicroUsd: number,
): { readonly to: 'customers' | 'testing'; readonly microUsd: number } {
  const to = body?.['to'];
  if (to !== 'customers' && to !== 'testing') {
    throw new ApiError(400, 'validation_failed', 'Choose the pool that receives the reserve.', [
      { field: 'to', message: 'must be customers or testing' },
    ]);
  }
  const maxCents = Math.floor(ceilingMicroUsd / MICRO_USD_PER_CENT);
  const microUsd =
    boundedInteger(body?.['amountCents'], 'amountCents', 1, maxCents) * MICRO_USD_PER_CENT;
  return { to, microUsd };
}

/** The settings the budget service runs on (the packs pool keeps the env share, 0 by default). */
export function aiBudgetSettingsOf(
  config: AiBudgetConfig,
  ceilingMicroUsd: number,
): AiBudgetSettings {
  const packs = poolCapsMicroUsd(ceilingMicroUsd).packs;
  const caps: Record<AiPool, number> = { ...config.capsMicroUsd, packs };
  return { poolCapsMicroUsd: caps, sonnetEnabled: config.sonnetEnabled, paused: config.paused };
}

/**
 * The budget's settings source over the process's 30-second `platform_settings` cache: the
 * admin's row when one is read, else the env defaults. The reader is looked up on every call, so
 * a module built before the reader was installed still sees it. Also the allowance resolver's
 * pool cap reader (`AiAllowanceService.poolCapMicroUsd`), so both read one figure.
 */
export class PlatformAiBudgetSettings implements AiBudgetSettingsSource {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly reader: () => PlatformSettingsReader | null = platformSettingsReader,
  ) {}

  async current(): Promise<AiBudgetSettings> {
    const ceiling = platformCapMicroUsd(this.env);
    const stored = (await this.reader()?.get(AI_BUDGET_SETTING)) ?? null;
    return aiBudgetSettingsOf(parseStoredAiBudget(stored, ceiling), ceiling);
  }

  readonly poolCapMicroUsd = async (pool: AiPool): Promise<number> =>
    (await this.current()).poolCapsMicroUsd[pool];
}

function usd(microUsd: number): string {
  return `${(microUsd / 1_000_000).toFixed(2)} USD`;
}
