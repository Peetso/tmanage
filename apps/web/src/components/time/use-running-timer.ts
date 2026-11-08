'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { getTimer } from '../../lib/api/time-timer';
import type { RunningTimer } from '../../lib/api/time-timer';
import { elapsedNow } from '../../lib/timer-state';

/** The cache key every timer surface shares, so a start or stop anywhere updates them all. */
export const timerKey = (organizationSlug: string) => ['time-timer', organizationSlug] as const;

/** Re-read the timer this often, so a timer stopped on another device leaves this one. */
const REFRESH_MS = 60_000;

export interface RunningTimerState {
  readonly timer: RunningTimer | null;
  readonly elapsedSeconds: number;
  readonly isPending: boolean;
}

/** 52-01. The caller's running timer and its elapsed seconds, ticking once a second. */
export function useRunningTimer(api: ApiClient, organizationSlug: string): RunningTimerState {
  const query = useQuery({
    queryKey: timerKey(organizationSlug),
    queryFn: async () => ({ state: await getTimer(api, organizationSlug), at: Date.now() }),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  // `?.` on the state too: an answer without one (an older API, a stub) reads as no timer.
  const timer = query.data?.state?.timer ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timer === null) return undefined;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [timer]);
  return {
    timer,
    elapsedSeconds: timer === null ? 0 : elapsedNow(timer, query.data?.at ?? now, now),
    isPending: query.isPending,
  };
}
