'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INITIAL_ACTIVITY_STATE, stepActivity } from '@tmanage/domain';
import type { ActivitySignal, ActivityStatus } from '@tmanage/domain';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  getAutoTracking,
  reportTrackingDevice,
  sendActivityHeartbeat,
} from '../../lib/api/time-auto';
import type { AutoTrackingState } from '../../lib/api/time-auto';
import {
  activitySupport,
  requestIdleDetection,
  startActivitySource,
  watchIdlePermission,
  type ActivitySupport,
  type IdlePermission,
} from '../../lib/activity-sources';
import { deviceToReport } from '../../lib/auto-timer-state';
import { desktopStartup } from './desktop-startup';

/** The cache key every automatic-timer surface shares. */
export const autoTrackingKey = (organizationSlug: string) =>
  ['time-auto', organizationSlug] as const;

/** Re-read the state this often, so a change on another device shows here. */
const REFRESH_MS = 60_000;

export interface AutoTracker {
  readonly state: AutoTrackingState | undefined;
  /** False when the API refused (a client principal, a signed-out page). */
  readonly available: boolean;
  /**
   * What this computer can report. `'unsupported'` until {@link detected} is true; read
   * `detected` before saying anything about it (TIMETRACK).
   */
  readonly support: ActivitySupport;
  /** TIMETRACK: true once the browser's abilities and permission are known. */
  readonly detected: boolean;
  /** Item 12: granted, not asked yet, or blocked in the site settings. */
  readonly permission: IdlePermission;
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

  // TIMETRACK: `null` = still checking. Starting from 'unsupported' / 'prompt' told the server that
  // a normal Chrome (and even the desktop app) "cannot track" before detection had run.
  const [detectedSupport, setSupport] = useState<ActivitySupport | null>(null);
  const [detectedPermission, setPermission] = useState<IdlePermission | null>(null);
  useEffect(() => {
    const found = activitySupport();
    setSupport(found);
    if (found === 'unsupported') return undefined;
    return watchIdlePermission(setPermission);
  }, []);
  const support: ActivitySupport = detectedSupport ?? 'unsupported';
  const permission: IdlePermission = detectedPermission ?? 'prompt';
  const detected =
    detectedSupport !== null && (detectedSupport === 'unsupported' || detectedPermission !== null);
  const permissionGranted = permission === 'granted';

  // Item 17: tell the server where tracking runs, once per kind, so the owner sees it.
  const policy = state?.policy;
  const reported = useRef<string | null>(null);
  // A refused report (the rate limit) is tried again at the next refresh, not dropped for good.
  const refreshedAt = query.dataUpdatedAt;
  useEffect(() => {
    const kind = deviceToReport(policy, detectedSupport, detectedPermission);
    if (kind === null || reported.current === kind) return;
    reported.current = kind;
    void reportTrackingDevice(api, organizationSlug, kind).catch((error: unknown) => {
      reported.current = null;
      // A refused report hides the owner's "Where it runs"; never let that pass unseen in dev.
      if (process.env.NODE_ENV !== 'production') {
        console.error('[auto-timer] the device report was refused', error);
      }
    });
  }, [api, organizationSlug, policy, detectedSupport, detectedPermission, refreshedAt]);

  // Item 16: in the desktop app, "On for everyone" starts the app with the computer by default.
  useEffect(() => {
    if (policy === undefined || support !== 'desktop') return;
    void desktopStartup()
      ?.applyDefault(policy === 'required')
      .catch(() => undefined);
  }, [policy, support]);

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
    const granted = await requestIdleDetection();
    // A refusal from the prompt reads as blocked until the site settings change it.
    setPermission(granted ? 'granted' : 'denied');
  }, []);

  return {
    state,
    available: query.isSuccess,
    support,
    detected,
    permission,
    status: running ? status : 'off',
    requestPermission,
  };
}
