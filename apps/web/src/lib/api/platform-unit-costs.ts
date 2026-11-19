import type { ApiClient } from './client';

/**
 * 62-A3 (B14) — the platform's monthly unit costs (`GET/PUT /v1/platform/settings/unit-costs`,
 * `platform.settings.edit`), in whole US cents a month. Mirrors the API's `UnitCostsView`
 * (`platform-admin/settings/unit-costs.service.ts`). `costs: null` = not set.
 */
export interface UnitCosts {
  readonly hostingCentsPerMonth: number;
  readonly mailCentsPerMonth: number;
}

export interface UnitCostsView {
  readonly costs: UnitCosts | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export const PLATFORM_UNIT_COSTS_QUERY_KEY = ['platform', 'unit-costs'] as const;

const PATH = '/v1/platform/settings/unit-costs';

export async function fetchUnitCosts(client: ApiClient): Promise<UnitCostsView> {
  const { data } = await client.request<UnitCostsView>({ path: PATH });
  return data;
}

export async function saveUnitCosts(client: ApiClient, costs: UnitCosts): Promise<UnitCostsView> {
  const { data } = await client.request<UnitCostsView>({ method: 'PUT', path: PATH, body: costs });
  return data;
}

/** "29.99" → 2999; `null` for anything that is not a non-negative amount with at most 2 decimals. */
export function centsFromInput(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d{1,6}(?:[.,]\d{1,2})?$/.test(value)) return null;
  const [whole = '0', cents = ''] = value.split(/[.,]/);
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'));
}

/** 2999 → "29.99" for the input field. */
export function inputFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
