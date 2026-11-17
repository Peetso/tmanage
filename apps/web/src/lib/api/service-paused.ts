import { ApiRequestError } from './errors';

/**
 * ADMINSVC2 — the API's refusal while the platform has switched a connected service off: 409 with
 * the stable detail `integration: switched_off` (never the same as "not set up yet", whose detail
 * is `not_configured`). Screens show the calm "paused" notice for it instead of their own error.
 */
export function isServicePaused(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.details.some(
      (detail) => detail.field === 'integration' && detail.message === 'switched_off',
    )
  );
}
