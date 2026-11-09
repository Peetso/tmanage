'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INITIAL_ACTIVITY_STATE, stepActivity } from '@tmanage/domain';
import type { ActivitySignal, ActivityStatus } from '@tmanage/domain';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { getAutoTracking, sendActivityHeartbeat } from '../../lib/api/time-auto';
import type { AutoTrackingState } from '../../lib/api/time-auto';
import {
  activitySupport,
  idleDetectionGranted,
  requestIdleDetection,
  startActivitySource,
  type ActivitySupport,
} from '../../lib/activity-sources';

/** The cache key every automatic-timer surface shares. */
export const autoTrackingKey = (organizationSlug: string) =>
  ['time-auto', organizationSlug] as const;

/** Re-read the state this often, so a change on another device shows here. */
const REFRESH_MS = 60_000;

export interface AutoTracker {
  readonly state: AutoTrackingState | undefined;
  /** False when the API refused (a client principal, a signed-out page). */
  readonly available: boolean;
  readonly support: ActivitySupport;
  readonly permissionGranted: boolean;
  readonly status: ActivityStatus;
  /** Ask Chrome / Edge for idle detection; call from a click. */
  readonly requestPermission: () => Promise<void>;
}

/**
 * FIX-2026-11-10 — runs the shared tracker (`stepActivity`, @tmanage/domain) on the computer's
 * activity signal while automatic tracking is on, and sends the heartbeats it asks for. Nothing is
 * sent while it is off, while a manual timer runs, or where the browser cannot see the computer.
 */
export function useAutoTracker(api: ApiClient, organizationSlug: string): AutoTracker {
  const queryClient = useQueryClient();
  const key = autoTrackingKey(organizationSlug);
  const query = useQuery({
    queryKey: key,
    queryFn: () => getAutoTracking(api, organizationSlug),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const state = query.data;

  const [support, setSupport] = useState<ActivitySupport>('unsupported');
  const [permissionGranted, setPermissionGranted] = useState(false);
  useEffect(() => {
    const found = activitySupport();
    setSupport(found);
    if (found !== 'unsupported') void idleDetectionGranted().then(setPermissionGranted);
  }, []);

  const heartbeat = useMutation({
    mutationFn: (idleSeconds: number) => sendActivityHeartbeat(api, organizationSlug, idleSeconds),
    onSuccess: (view) => queryClient.setQueryData(key, view),
    onError: (error) => {
      // Turned off elsewhere (the owner's policy or another device): read the state again.
      if (error instanceof ApiRequestError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
  const send = heartbeat.mutate;

  const tracker = useRef(INITIAL_ACTIVITY_STATE);
  const [status, setStatus] = useState<ActivityStatus>('off');
  const running =
    state !== undefined &&
    state.enabled &&
    !state.manualTimerRunning &&
    support !== 'unsupported' &&
    permissionGranted;
  const thresholdSeconds = (state?.idleThresholdMinutes ?? 5) * 60;

  useEffect(() => {
    if (!running) return undefined;
    const feed = (signal: ActivitySignal) => {
      const step = stepActivity(tracker.current, signal);
      tracker.current = step.state;
      setStatus(step.state.status);
      if (step.heartbeat !== null) send(step.heartbeat.idleSeconds);
    };
    feed({ type: 'enable', idleThresholdSeconds: thresholdSeconds });
    const stop = startActivitySource(feed);
    return () => {
      stop();
      feed({ type: 'disable' });
    };
  }, [running, thresholdSeconds, send]);

  const requestPermission = useCallback(async () => {
    setPermissionGranted(await requestIdleDetection());
  }, []);

  return {
    state,
    available: query.isSuccess,
    support,
    permissionGranted,
    status: running ? status : 'off',
    requestPermission,
  };
}
