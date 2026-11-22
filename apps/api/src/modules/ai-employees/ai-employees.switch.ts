import { ApiError, MESSAGES } from '../../common/http/errors.js';

/**
 * The server switch for the AI-employee surface (plan 60 v2). Its own file, with no other import,
 * so the authentication and tenant guards can ask it without loading the service.
 */

/** The environment variable that turns the AI-employee surface on for this server. */
export const AI_EMPLOYEES_SWITCH = 'TMANAGE_AI_EMPLOYEES';

/**
 * Whether this server exposes the AI-employee surface: only the exact value `on`. Absent, empty,
 * `off`, `ON` or anything else is off (fail closed). It stays off until 60-04, 60-05, 60-06 and
 * 60-09 (seats and headcount) have shipped; the platform owner then sets it in Hostinger.
 */
export function aiEmployeesEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[AI_EMPLOYEES_SWITCH] === 'on';
}

/** The refusal while the switch is off: the same 404 as a feature flag that is off (52-24). */
export function aiEmployeesOff(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'feature.ai_employees_off');
}
