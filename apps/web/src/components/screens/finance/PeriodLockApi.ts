import type { ApiClient } from '../../../lib/api/client';

/**
 * Period locks (52-03): `GET …/time/locks` on `finance.view`; `POST …/time/locks` (close whole months)
 * and `DELETE …/time/locks/:id` (reopen, with a reason) on `finance.manage`. Mirrors the API's
 * `TimeLockView`.
 */

export interface PeriodLockRow {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly open: boolean;
  readonly lockedBy: string;
  readonly lockedAt: string;
  readonly unlockedBy: string | null;
  readonly unlockedAt: string | null;
  readonly reason: string | null;
  readonly entriesLocked: number;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/time/locks`;
}

export async function listPeriodLocks(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly PeriodLockRow[]> {
  const { data } = await client.request<{ locks: readonly PeriodLockRow[] }>({
    path: `${base(organizationSlug)}?limit=100`,
  });
  return data.locks;
}

export async function closePeriod(
  client: ApiClient,
  organizationSlug: string,
  window: { readonly periodStart: string; readonly periodEnd: string },
): Promise<PeriodLockRow> {
  const { data } = await client.request<PeriodLockRow>({
    method: 'POST',
    path: base(organizationSlug),
    body: window,
  });
  return data;
}

export async function reopenPeriod(
  client: ApiClient,
  organizationSlug: string,
  lockId: string,
  reason: string,
): Promise<PeriodLockRow> {
  const { data } = await client.request<PeriodLockRow>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(lockId)}`,
    body: { reason },
  });
  return data;
}
