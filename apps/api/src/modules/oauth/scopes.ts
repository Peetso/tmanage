/**
 * OAuth scopes — MCP-CONNECTOR-PLAN §4.2. Scopes only ever *narrow* access: a tool runs only if
 * the scope allows it AND the member's capability allows it AND the object check allows it.
 *
 * S7 defines the vocabulary and the parse/validate rules the authorize and token endpoints share.
 * The mapping from a scope to the risk classes it unlocks is applied by the MCP layer (S5/S6) and
 * the consent UI (S9); this module is the authoritative list and the parser.
 */

export const SCOPE_READ = 'tmanage:read';
export const SCOPE_WRITE = 'tmanage:write';
export const SCOPE_MANAGE = 'tmanage:manage';
export const SCOPE_BILLING = 'tmanage:billing';

/** Every scope TManage recognises, in the fixed display order the consent page uses. */
export const KNOWN_SCOPES: readonly string[] = Object.freeze([
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_MANAGE,
  SCOPE_BILLING,
]);

/** The default a client gets when it asks for none: read plus everyday write (§4.2). */
export const DEFAULT_SCOPES: readonly string[] = Object.freeze([SCOPE_READ, SCOPE_WRITE]);

export function isKnownScope(scope: string): boolean {
  return KNOWN_SCOPES.includes(scope);
}

/**
 * Parse a space-delimited `scope` parameter into the known scopes it names, de-duplicated and
 * returned in the canonical display order. An unknown scope is a hard error rather than being
 * silently dropped, so a client cannot believe it was granted something it was not and the
 * consent page never shows a scope TManage cannot explain.
 */
export function parseScopes(raw: unknown): readonly string[] {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_SCOPES;
  if (typeof raw !== 'string') {
    throw new InvalidScopeError('The scope parameter must be a space-delimited string.');
  }
  const requested = new Set(raw.split(/\s+/).filter((s) => s.length > 0));
  for (const scope of requested) {
    if (!isKnownScope(scope)) throw new InvalidScopeError(`Unknown scope: ${scope}`);
  }
  if (requested.size === 0) return DEFAULT_SCOPES;
  return KNOWN_SCOPES.filter((scope) => requested.has(scope));
}

/** The canonical stored/returned form: space-delimited, in display order. */
export function scopesToString(scopes: readonly string[]): string {
  return KNOWN_SCOPES.filter((scope) => scopes.includes(scope)).join(' ');
}

/** `invalid_scope` per RFC 6749 §4.1.2.1 / §5.2. */
export class InvalidScopeError extends Error {
  override name = 'InvalidScopeError';
}

/** The registry's short scope names (`AiActionOp.scope`) mapped to the OAuth scope strings. */
const SHORT_TO_SCOPE: Readonly<Record<string, string>> = Object.freeze({
  read: SCOPE_READ,
  write: SCOPE_WRITE,
  manage: SCOPE_MANAGE,
  billing: SCOPE_BILLING,
});

/** The OAuth scope an op needs, from its registry scope (`read`, `write`, `manage`, `billing`). */
export function requiredScopeFor(opScope: string): string | null {
  return SHORT_TO_SCOPE[opScope] ?? null;
}

/** Does a grant's scope string (space-delimited, as stored) cover the required scope? */
export function grantCoversScope(grantedScopes: string, required: string): boolean {
  return grantedScopes.split(/\s+/).includes(required);
}

/**
 * The step-up challenge for a call the grant does not cover (MCP authorization "scope
 * challenge", T-SCP-01): HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`
 * naming the scopes the client should ask for — what it already holds plus the one it lacks —
 * and the protected-resource metadata, so it can send the person back through consent.
 */
export function insufficientScopeChallenge(input: {
  readonly grantedScopes: string;
  readonly required: string;
  readonly resourceMetadataUrl: string;
}): { readonly status: 403; readonly wwwAuthenticate: string } {
  const wanted = parseScopes(`${input.grantedScopes} ${input.required}`);
  return {
    status: 403,
    wwwAuthenticate:
      `Bearer error="insufficient_scope", scope="${scopesToString(wanted)}", ` +
      `resource_metadata="${input.resourceMetadataUrl}"`,
  };
}
