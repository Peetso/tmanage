'use client';

import { useQuery } from '@tanstack/react-query';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import { fetchPlatformMe } from '../../../lib/api/platform-admin';
import type { PlatformMeView } from '../../../lib/api/platform-admin';

/**
 * The signed-in platform admin's permissions (SPEC §3.1), read from `GET /v1/platform/me` under
 * the shared `['platform', 'me']` key, so every screen and the shell share one request.
 *
 * The API is the authority — every route carries `@RequirePlatformPermission` — so a screen uses
 * this only to hide or disable what would be refused anyway.
 */

export const PLATFORM_ME_QUERY_KEY = ['platform', 'me'] as const;

/** A destructive act needs at least this much step-up left (SPEC §8: "< 60 s left" re-confirms). */
export const STEP_UP_MIN_SECONDS = 60;

/** Seconds left on the step-up window at `now`, 0 when none or lapsed. */
export function stepUpRemainingSeconds(
  me: Pick<PlatformMeView, 'stepUpExpiresAt'> | null | undefined,
  now: number = Date.now(),
): number {
  if (!me || me.stepUpExpiresAt === null) return 0;
  const at = new Date(me.stepUpExpiresAt).getTime();
  if (Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((at - now) / 1000));
}

/** The permission a 403 `platform_permission_missing` names, or `null` for any other error. */
export function missingPlatformPermission(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.status !== 403) return null;
  // `errors.ts` folds a code it does not list into `forbidden`, so the guard's detail row —
  // `{field: 'permission', message: <key>}`, unique to this refusal — identifies it as well.
  const named = error.details.find((detail) => detail.field === 'permission');
  if ((error.code as string) !== 'platform_permission_missing' && named === undefined) return null;
  return named?.message ?? '';
}

export interface PlatformPermissions {
  readonly me: PlatformMeView | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly permissions: ReadonlySet<string>;
  readonly preset: PlatformMeView['preset'] | null;
  readonly has: (permission: string) => boolean;
  readonly stepUpRemainingSeconds: number;
}

export function usePlatformPermissions(client?: ApiClient): PlatformPermissions {
  const api = client ?? browserApiClient();
  const me = useQuery({
    queryKey: PLATFORM_ME_QUERY_KEY,
    queryFn: () => fetchPlatformMe(api),
    retry: false,
    refetchInterval: 60_000,
  });
  const permissions = new Set<string>(me.data?.permissions ?? []);
  return {
    me: me.data,
    isPending: me.isPending,
    isError: me.isError,
    error: me.error,
    permissions,
    preset: me.data?.preset ?? null,
    has: (permission) => permissions.has(permission),
    stepUpRemainingSeconds: stepUpRemainingSeconds(me.data),
  };
}
