import { validateRegistrationRedirectUris } from './redirect-uri.js';

/**
 * Dynamic Client Registration metadata validation and sanitising (RFC 7591; MCP connector S8,
 * threat model row B1 "Malicious DCR"). Every field a client POSTs to `/oauth/register` is
 * checked here before a row is written. The rules, verbatim from the threat model:
 *
 *   - `client_name` ≤ 60 chars, plain text, control characters stripped.
 *   - `logo_uri` and `client_uri` must be https and are **not** fetched or shown as images
 *     (a text initial only). TManage stores neither — they are validated-if-present and echoed.
 *   - `redirect_uris` follow the redirect rules (`redirect-uri.ts`): https, or loopback http,
 *     no fragment, exact-match allow-list.
 *   - `grant_types` only `authorization_code` and `refresh_token`.
 *   - `token_endpoint_auth_method` = `none` (public clients; no secret is ever issued).
 *
 * This is a pure function so T-DCR-01 can pin each branch without a database or a server.
 */

/** `invalid_client_metadata` / `invalid_redirect_uri` per RFC 7591 §3.2.2. */
export class DcrValidationError extends Error {
  constructor(
    readonly code: 'invalid_client_metadata' | 'invalid_redirect_uri',
    readonly description: string,
  ) {
    super(description);
    this.name = 'DcrValidationError';
  }
}

/** The only grant types a public MCP client may register for. */
const ALLOWED_GRANT_TYPES: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token']);

/** `client_name` cap (threat model B1). The schema column is wider; the rule is the tighter bound. */
export const MAX_CLIENT_NAME_LENGTH = 60;

export interface ValidatedDcrClient {
  /** The sanitised display name, ≤ 60 chars, control characters removed. */
  readonly name: string;
  /** The validated, de-duplicated redirect-URI allow-list. */
  readonly redirectUris: string[];
}

/**
 * Sanitise a display name: drop control characters (C0, C1 and DEL, which includes newlines and
 * tabs), collapse runs of whitespace, trim, and cap at 60 characters. HTML-looking input is not
 * special — it is kept as the plain text it is and escaped wherever it is rendered (S9) — but a
 * name that is only control characters or whitespace collapses to empty and the caller defaults.
 */
export function sanitiseClientName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- intentionally stripping C0/C1/DEL control chars.
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_CLIENT_NAME_LENGTH);
}

function assertHttpsIfPresent(value: unknown, field: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    throw new DcrValidationError('invalid_client_metadata', `${field} must be a string.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DcrValidationError('invalid_client_metadata', `${field} is not a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new DcrValidationError('invalid_client_metadata', `${field} must be https.`);
  }
}

/**
 * Validate a DCR request body (a parsed JSON object) and return the two fields TManage persists.
 * Throws `DcrValidationError` on any violation — a bad redirect, a `javascript:` URI, an
 * unsupported grant type, or a non-`none` auth method are refused rather than coerced.
 */
export function validateDcrRegistration(body: Record<string, unknown>): ValidatedDcrClient {
  let redirectUris: string[];
  try {
    redirectUris = validateRegistrationRedirectUris(body['redirect_uris']);
  } catch (error) {
    throw new DcrValidationError(
      'invalid_redirect_uri',
      error instanceof Error ? error.message : 'Invalid redirect_uris.',
    );
  }

  const grantTypes = body['grant_types'];
  if (grantTypes !== undefined) {
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => typeof g !== 'string')) {
      throw new DcrValidationError('invalid_client_metadata', 'grant_types must be an array.');
    }
    for (const grant of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.has(grant as string)) {
        throw new DcrValidationError(
          'invalid_client_metadata',
          `Unsupported grant_type: ${String(grant)}.`,
        );
      }
    }
  }

  const responseTypes = body['response_types'];
  if (responseTypes !== undefined) {
    if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
      throw new DcrValidationError('invalid_client_metadata', 'response_types must be ["code"].');
    }
  }

  const authMethod = body['token_endpoint_auth_method'];
  if (authMethod !== undefined && authMethod !== 'none') {
    throw new DcrValidationError(
      'invalid_client_metadata',
      'token_endpoint_auth_method must be "none" (public clients only).',
    );
  }

  assertHttpsIfPresent(body['logo_uri'], 'logo_uri');
  assertHttpsIfPresent(body['client_uri'], 'client_uri');

  const name = sanitiseClientName(body['client_name']) || 'AI client';
  return { name, redirectUris };
}
