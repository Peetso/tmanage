'use client';

import { useEffect } from 'react';
import { ServerErrorState, StateScreen } from '../components/state/StateScreens';

/**
 * The 500 route — Next's error boundary for the app.
 *
 * It must be a client component: Next hands it the caught `error` and a `reset` that re-renders
 * the failed segment. `reset` becomes the "Try again" action of the shared `ServerErrorState`,
 * so a person meets one retry rather than a stack trace. The error is logged to the console —
 * the one channel the boundary honestly has — and never rendered, so an internal message or a
 * digest never reaches a person.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StateScreen>
      <ServerErrorState onRetry={reset} />
    </StateScreen>
  );
}
