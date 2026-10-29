'use client';

import type { ReactNode } from 'react';
import type { ApiClient } from '../../../lib/api/client';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { StepUpForm } from './platform-kit';
import { STEP_UP_MIN_SECONDS, stepUpRemainingSeconds } from './usePlatformPermissions';

/**
 * Renders `children` only while the step-up is live — with at least a minute left when `strict`
 * (SPEC §8: entering Support mode and every destructive act need a *live* confirmation, and the
 * API refuses with < 60 s left). Otherwise the step-up form takes their place.
 */
export function StepUpGate({
  api,
  me,
  strict = false,
  now,
  children,
}: {
  api: ApiClient;
  me: PlatformMeView;
  strict?: boolean;
  /** Injected in tests. */
  now?: number;
  children: ReactNode;
}) {
  const remaining = stepUpRemainingSeconds(me, now);
  const live = strict ? remaining >= STEP_UP_MIN_SECONDS : remaining > 0;
  if (!live) return <StepUpForm api={api} me={me} />;
  return <>{children}</>;
}
