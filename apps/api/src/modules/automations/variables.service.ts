import { ApiError } from '../../common/http/errors.js';

/**
 * Automation-variables validation (module 17, x305) — the pure rules that stand between the wire and a
 * write, kept out of the controller so they are provable without a Nest fixture.
 *
 * The feature is deliberately **non-secret only**. A credential/secret store is a separate
 * Needs-Peter item; nothing here may be used to smuggle one in, so a key whose name looks secret-like
 * is refused before any write.
 */

/** `automation_variables.var_key` is `VARCHAR(64)`. A safe identifier: a letter then up to 63 more. */
export const VAR_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** `automation_variables.var_value` is `VARCHAR(2000)`. A non-secret template variable is short. */
export const MAX_VAR_VALUE_LENGTH = 2000;

/**
 * Case-insensitive name fragments that mark a key as secret-like. A variable named `apiToken`,
 * `db_password`, `client_secret` or `signingKey` is rejected 400 with no write — secrets are out of
 * scope for this feature. The match is a substring so `passwordHint` and `mySecretFlag` are refused
 * too; that over-breadth is intentional, since the safe thing when a name suggests a secret is to
 * refuse it.
 */
export const SECRET_LIKE_FRAGMENTS = ['password', 'token', 'secret', 'key'] as const;

/**
 * Validate a `var_key` from the path. Returns it unchanged when it is a safe identifier and not
 * secret-like; otherwise throws a 400 with nothing written. The `secret-like` refusal carries a
 * distinct audit code so the proof (and the audit trail) can tell it apart from a malformed key.
 */
export function validateVarKey(raw: string): string {
  if (!VAR_KEY_PATTERN.test(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request is invalid',
      [
        {
          field: 'key',
          message: 'must start with a letter and use only letters, digits or underscore (max 64)',
        },
      ],
      'automation_variable_key_invalid',
    );
  }
  const lowered = raw.toLowerCase();
  if (SECRET_LIKE_FRAGMENTS.some((fragment) => lowered.includes(fragment))) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request is invalid',
      [
        {
          field: 'key',
          message: 'a secret-like name is not allowed; variables are non-secret only',
        },
      ],
      'automation_variable_key_secret_like',
    );
  }
  return raw;
}

/** Validate a `value` from the body. Must be a string within the column cap; otherwise 400, no write. */
export function validateVarValue(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: 'must be a string' },
    ]);
  }
  if (raw.length > MAX_VAR_VALUE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: `must be ${MAX_VAR_VALUE_LENGTH} characters or fewer` },
    ]);
  }
  return raw;
}
