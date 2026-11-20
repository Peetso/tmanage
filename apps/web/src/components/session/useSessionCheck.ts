'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { checkSession, type SessionCheck } from '../../lib/session-check';

/**
 * AUTHSTATE — the React side of the shared session check (`lib/session-check.ts`).
 *
 * `checking` until the API has answered; then the check's answer. `unknown` is never final:
 * the check runs again after 1, 2, 4, 8 and then every 15 seconds, and `retryNow` runs it at once.
 * A sign-in or sign-out in another tab runs it again too.
 */
export type SessionView = { readonly state: 'checking' } | SessionCheck;

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

/** The wait before retry number `attempt` (0-based): doubling, then capped. */
export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
}

export interface UseSessionCheckOptions {
  readonly client: ApiClient;
  /** The readable CSRF cookie is present (`browserMayHaveSession`). */
  readonly mayHaveSession: () => boolean;
  /** False skips the check (the view stays `checking`). */
  readonly enabled?: boolean;
  /** Injected in tests. */
  readonly boundary?: AuthBoundary;
}

export function useSessionCheck({
  client,
  mayHaveSession,
  enabled = true,
  boundary = authBoundary,
}: UseSessionCheckOptions): { readonly view: SessionView; readonly retryNow: () => void } {
  const [view, setView] = useState<SessionView>({ state: 'checking' });
  const [run, setRun] = useState(0);
  const attempt = useRef(0);

  const retryNow = useCallback(() => setRun((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void checkSession(client, { mayHaveSession: mayHaveSession() }).then((answer) => {
      if (!live) return;
      setView(answer);
      if (answer.state === 'unknown') {
        timer = setTimeout(retryNow, retryDelay(attempt.current));
        attempt.current += 1;
      } else {
        attempt.current = 0;
      }
    });
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // `mayHaveSession` is read per run on purpose; a new function identity is not a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, enabled, run, retryNow]);

  // Another tab signed in or out: ask again. This tab's own notices are its own navigation.
  useEffect(
    () =>
      boundary.subscribe((notice) => {
        if (notice.origin === 'remote') retryNow();
      }),
    [boundary, retryNow],
  );

  return { view, retryNow };
}
