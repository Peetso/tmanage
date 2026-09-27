import { ApiError } from '../../common/http/errors.js';
import { LANDING_KEYS } from '../../common/database/schema.js';
import type { LandingKey } from '../../common/database/schema.js';

/**
 * PREF-STARTUP's landing-key validation (module 20 Preferences & accessibility, x287).
 *
 * The one decision this slice makes — is the requested startup destination one the shell can route
 * to? — is a pure function of the request body and the closed vocabulary, kept out of the controller
 * and the store so it can be exercised in isolation. It reads no database. The allowlist
 * ({@link LANDING_KEYS}) is the closed set of known destinations; a body carrying anything else — an
 * unknown key, a value off the list (e.g. `payroll`), a non-string, or an extra field — is the
 * client's error to be told about (400), never a state the store should hold, so nothing is written.
 */

/** The shipped default an unsaved member routes to on sign-in. */
export const DEFAULT_LANDING_KEY: LandingKey = 'home';

/** The only key a PUT body may carry — anything else is a 400 (fixed-key allowlist). */
const ALLOWED_KEYS: ReadonlySet<string> = new Set(['landingKey']);

/** Whether `value` is one of the known landing destinations the shell can route to. */
export function isLandingKey(value: unknown): value is LandingKey {
  return typeof value === 'string' && (LANDING_KEYS as readonly string[]).includes(value);
}

/**
 * Validate a PUT body and return the accepted landing key, or throw a 400 with the offending fields.
 *
 * The body must carry exactly `landingKey`, and its value must be on {@link LANDING_KEYS}. Validation
 * lives here rather than in the store because a malformed body is the client's error, not a value the
 * store should ever hold — and the refusal (a value off the allowlist writes nothing) is proven by
 * the controller unit test.
 */
export function parseStartupInput(body: unknown): LandingKey {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  // Fixed-key allowlist: a key the store has no column for is the client's error, not a silent drop.
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      details.push({ field: key, message: 'is not a known preference' });
    }
  }

  const landingKey = value['landingKey'];
  if (!isLandingKey(landingKey)) {
    details.push({
      field: 'landingKey',
      message: `must be one of ${LANDING_KEYS.join(', ')}`,
    });
  }

  if (details.length > 0) {
    throw new ApiError(
      400,
      'validation_failed',
      'The startup landing preference is invalid',
      details,
    );
  }

  return landingKey as LandingKey;
}
