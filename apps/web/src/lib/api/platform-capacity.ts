import type { ApiClient } from './client';

/**
 * Platform admin · Host capacity (`GET /v1/platform/health/capacity`, plan 56-32): six gauges
 * against the shared-hosting plan ceilings and the latest readings. Needs `platform.activity.view`.
 *
 * Paired with the API view in `e2e/contracts/api-web-shapes.ts`.
 */

export type CapacityGaugeKey =
  'ram' | 'loop_lag' | 'sockets' | 'inodes' | 'disk' | 'db_connections';
export type CapacityGaugeColour = 'green' | 'amber' | 'red';

export interface CapacityHostProfileView {
  readonly plan: string | null;
  readonly ramMb: number;
  readonly loopLagMs: number;
  readonly sockets: number;
  readonly inodes: number;
  readonly diskMb: number;
  readonly dbConnections: number;
  readonly measuredAt: string | null;
  readonly source: 'planning' | 'settings';
}

export interface CapacityReadingView {
  readonly takenAt: string;
  readonly source: string;
  readonly rssMb: number;
  readonly heapMb: number;
  readonly loopLagMs: number;
  readonly sockets: number | null;
  readonly inodes: number | null;
  readonly diskMb: number | null;
  readonly dbMb: number | null;
  readonly dbConnections: number | null;
}

export interface CapacityGaugeView {
  readonly key: CapacityGaugeKey;
  readonly value: number;
  readonly ceiling: number;
  readonly percent: number;
  readonly colour: CapacityGaugeColour;
  readonly budgetPercent: number;
  readonly withinBudget: boolean;
}

export interface CapacityView {
  readonly profile: CapacityHostProfileView;
  readonly latest: {
    readonly sample: CapacityReadingView | null;
    readonly nightly: CapacityReadingView | null;
  };
  readonly gauges: readonly CapacityGaugeView[];
  readonly trigger: { readonly sentence: string; readonly days: number; readonly due: boolean };
  readonly redStreakDays: number;
}

export async function fetchPlatformCapacity(client: ApiClient): Promise<CapacityView> {
  const { data } = await client.request<CapacityView>({
    method: 'GET',
    path: '/v1/platform/health/capacity',
  });
  return data;
}
