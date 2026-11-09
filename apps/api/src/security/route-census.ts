/**
 * 56-15 — the route authorization census, a Secure SDLC gate.
 *
 * Every live HTTP route must fall into exactly one reviewed authorization class. The census test
 * (`sdlc-census.test.ts`) reads every controller's metadata and fails on any route this module
 * cannot place, so a new route cannot ship without its author deciding — in the diff, where a
 * reviewer sees it — who may call it:
 *
 * | class          | rule                                                                          |
 * | -------------- | ----------------------------------------------------------------------------- |
 * | `public`       | `@Public()`, listed in {@link PUBLIC_ROUTES} with a named throttle or a reason |
 * | `org`          | under `/v1/organizations/:orgSlug`, carries `@RequireCapability`               |
 * | `platform`     | under `/v1/platform`, behind `PlatformAdminGuard` with a platform permission   |
 * | `session-only` | signed in, acts only on the caller's own account — {@link SESSION_ONLY_ROUTES} |
 *
 * The AI-connector registry (`ai-actions/registry/registry-sync.test.ts`) answers a different
 * question — may the AI call it? — and is not replaced by this one.
 */

export interface CensusRoute {
  /** `METHOD /path`, the path as the router joins it. */
  readonly key: string;
  /** `Controller.handler`, the key {@link PUBLIC_ROUTE_POLICIES} uses. */
  readonly handlerKey: string;
  readonly isPublic: boolean;
  readonly hasCapability: boolean;
  readonly hasPlatformPermission: boolean;
  readonly hasPlatformGuard: boolean;
  /** A `@Throttle` decorator or a `PUBLIC_ROUTE_POLICIES` entry — a budget someone chose. */
  readonly hasNamedThrottle: boolean;
}

export type RouteClass = 'public' | 'org' | 'platform' | 'session-only';

/**
 * The reviewed anonymous surface. A value of `'named'` asserts the route has a budget of its own;
 * any other value is the reason it may run on `DEFAULT_PUBLIC_POLICY` (reads, OAuth callbacks).
 */
export const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  'PUT /v1/uploads/:providerUploadId/parts/:n': 'named',
  'GET /v1/auth/google/': 'read: is Google sign-in configured',
  'POST /v1/auth/google/start': 'pending named budget: starts a redirect, writes a state row',
  'GET /v1/auth/google/callback': 'OAuth callback: single-use state',
  'POST /v1/auth/google/mfa': 'pending named budget: needs the pending-MFA cookie',
  'POST /v1/auth/sso/start': 'pending named budget: starts a redirect, signed state cookie',
  'GET /v1/auth/sso/callback': 'OIDC callback: signed single-use state and nonce',
  'POST /v1/auth/sso/mfa': 'pending named budget: needs the pending-MFA cookie',
  'POST /v1/auth/sso/saml/acs':
    'pending named budget: SAML reply URL, signed flow cookie and RelayState',
  'GET /v1/auth/sso/saml/metadata': 'public service-provider metadata, no secrets',
  // 54-16 SCIM 2.0: the provider's hashed bearer key names the organization; per-address and
  // per-key in-controller limiters (600 and 300 a minute); an unknown or revoked key is a 401.
  'GET /v1/scim/v2/ServiceProviderConfig':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/ResourceTypes':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/Schemas':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/Users':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/Users/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'POST /v1/scim/v2/Users':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'PUT /v1/scim/v2/Users/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'PATCH /v1/scim/v2/Users/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'DELETE /v1/scim/v2/Users/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/Groups':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'GET /v1/scim/v2/Groups/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'POST /v1/scim/v2/Groups':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'PUT /v1/scim/v2/Groups/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'PATCH /v1/scim/v2/Groups/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  'DELETE /v1/scim/v2/Groups/:id':
    'pending named budget: SCIM bearer key (hashed, per org); in-controller limiters',
  // 56-22 passkey sign-in: per-address limiter (60 per 10 minutes), signed single-use challenge.
  'POST /v1/auth/passkey/options':
    'pending named budget: in-controller per-address limiter; signed challenge, no I/O',
  'POST /v1/auth/passkey/':
    'pending named budget: in-controller per-address limiter; single-use challenge, WebAuthn assertion',
  'GET /v1/integrations/google-calendar/callback': 'OAuth callback: single-use state',
  'GET /v1/integrations/google-drive/callback': 'OAuth callback: single-use state',
  'GET /v1/integrations/microsoft-calendar/callback': 'OAuth callback: single-use state',
  'GET /v1/integrations/onedrive/callback': 'OAuth callback: single-use state',
  'GET /v1/integrations/figma/callback': 'OAuth callback: single-use state',
  'POST /v1/auth/password': 'named',
  'POST /v1/auth/mfa': 'named',
  'POST /v1/auth/recovery-code': 'named',
  'POST /v1/password-resets/': 'named',
  'POST /v1/password-resets/completions': 'named',
  'POST /v1/sessions/refresh': 'named',
  'POST /v1/dev/sessions/':
    'pending named budget: development-only sign-in (registerWithDevelopmentSignIn)',
  'GET /openapi/ai.json': 'read: public connector description',
  'GET /downloads/tmanage-mcp.tgz': 'read: public connector bridge download',
  'GET /oauth/authorize': 'read: renders consent, issues nothing without a session',
  'GET /.well-known/oauth-protected-resource/mcp': 'read: RFC 9728 metadata',
  'GET /.well-known/oauth-protected-resource': 'read: RFC 9728 metadata',
  'GET /.well-known/oauth-authorization-server': 'read: RFC 8414 metadata',
  'POST /oauth/register': 'named',
  'POST /oauth/revoke': 'named',
  'POST /oauth/token': 'named',
  'GET /public/site/maintenance': 'read: marketing site',
  'GET /public/site/announcements': 'read: marketing site',
  'POST /public/site/contact': 'named',
  'GET /v1/public/site/changelog': 'read: marketing site',
  'GET /v1/public/site/faq': 'read: marketing site',
  'GET /v1/public/locale-hint': 'read: marketing site',
  'GET /v1/public/webhook-events': 'read: public webhook event catalogue (R13-s2), no data',
  'GET /v1/public/site/legal/:doc': 'read: marketing site',
  'GET /v1/public/site/plans': 'read: marketing site',
  'GET /v1/public/site/home': 'read: marketing site',
  'GET /v1/public/site/resources/': 'read: marketing site',
  'GET /v1/public/site/resources/:slug': 'read: marketing site',
  'GET /v1/public/site/status/summary': 'read: marketing site',
  'GET /v1/public/site/status': 'read: marketing site',
  'GET /v1/public/site/trust': 'read: marketing site',
  'GET /v1/public/site/data-location': 'read: marketing site',
  'GET /public/setup/': 'read: is first-owner setup open',
  'POST /public/setup/': 'named',
  'GET /v1/public/sign-up/': 'read: is sign-up open',
  'POST /v1/public/sign-up/': 'named',
  'POST /v1/invitations/previews': 'named',
  'POST /v1/invitations/registrations': 'named',
  'POST /v1/public/email/unsubscribe': 'pending named budget: RFC 8058 one-click, signed token',
  'GET /v1/public/email/unsubscribe': 'read: redirects to the unsubscribe page',
  'GET /v1/public/form-proof/': 'named',
  'GET /v1/public/links/:token/': 'named',
  'POST /v1/public/links/:token/code': 'named',
  'POST /v1/public/links/:token/decision': 'named',
  'POST /v1/public/portal-sign-in/': 'named',
  'POST /v1/public/portal-sign-in/code': 'named',
  'GET /v1/public/portal-sign-in/links/:token': 'named',
  'POST /v1/public/portal-sign-in/links/:token/consume': 'named',
  'POST /v1/public/portal-sign-in/links/:token/not-you': 'named',
  'GET /v1/public/forms/:slug': 'named',
  'POST /v1/public/forms/:slug/submissions': 'named',
  'POST /v1/public/security-reports/': 'named',
  // R16-e (54-10): GitHub repository webhook delivery — HMAC per hook, per-hook throttle.
  'POST /v1/public/integrations/github/:hookId': 'named',
  // R22-c (54-12): inbound e-mail provider webhook - signed delivery, named throttle.
  'POST /v1/public/inbound-email/webhook': 'named',
};

/** Signed-in routes with no capability because they act only on the caller's own account. */
export const SESSION_ONLY_ROUTES: Readonly<Record<string, string>> = {
  'POST /v1/auth/reauth': 'own session step-up',
  'POST /v1/auth/password/set': 'own password',
  'POST /v1/auth/factors/totp': 'own second factor',
  'POST /v1/auth/factors/totp/confirm': 'own second factor',
  'GET /v1/auth/factors': 'own second factors',
  'GET /v1/auth/security-activity': 'own sign-in history',
  'DELETE /v1/auth/factors/:factorId': 'own second factor',
  'GET /v1/auth/passkeys': 'own passkeys',
  'POST /v1/auth/passkeys/options': 'own passkey registration challenge',
  'POST /v1/auth/passkeys': 'own passkey (fresh proof)',
  'DELETE /v1/auth/passkeys/:passkeyId': 'own passkey (fresh proof, else 404)',
  'GET /v1/auth/security-score': 'own security score',
  'GET /v1/auth/security-devices': 'own devices',
  'POST /v1/auth/recovery-codes': 'own recovery codes',
  'DELETE /v1/sessions/current': 'own session',
  'GET /v1/sessions/current/devices': 'own devices',
  'GET /v1/me/sessions/:sessionId/trail.csv': 'own session trail (owner-checked, else 404)',
  'DELETE /v1/sessions/': 'own sessions',
  'DELETE /v1/sessions/:sessionId': 'own session',
  'POST /mcp/': 'AI connector: OAuth bearer, each op re-checked against the registry',
  'GET /mcp/': 'AI connector: OAuth bearer',
  'DELETE /mcp/': 'AI connector: OAuth bearer',
  'GET /v1/oauth/consent': 'own consent screen',
  'POST /v1/oauth/consent/deny': 'own consent decision',
  'POST /v1/invitations/acceptances': 'accept an invitation addressed to the caller',
  'GET /v1/organizations/address-availability': 'before any organization exists',
  'GET /v1/organizations/': "the caller's own memberships",
  'POST /v1/organizations/': 'create a new organization the caller will own',
};

/** Platform routes the guard alone authorizes: the admin's own profile and step-up. */
export const PLATFORM_SELF_ROUTES: Readonly<Record<string, string>> = {
  'GET /v1/platform/me': "the admin's own permissions",
  'POST /v1/platform/step-up': "the admin's own step-up",
  'GET /v1/platform/support-sessions/:id': 'the support session the admin opened (owner-checked)',
};

const ORG_PREFIX = /^[A-Z]+ \/v1\/organizations\/:orgSlug(?:\/|$)/;
const PLATFORM_PREFIX = /^[A-Z]+ \/v1\/platform(?:\/|$)/;
const MUTATING = /^(?:POST|PUT|PATCH|DELETE) /;

/** The class a route belongs to, or why it belongs to none. */
export function classifyRoute(route: CensusRoute): RouteClass | { violation: string } {
  const { key } = route;
  if (route.isPublic) {
    if (route.hasCapability) return { violation: 'is @Public() and also requires a capability' };
    const reason = PUBLIC_ROUTES[key];
    if (reason === undefined) return { violation: 'is @Public() but not in PUBLIC_ROUTES' };
    if (reason === 'named' && !route.hasNamedThrottle)
      return { violation: 'is listed as a named budget but has no @Throttle / policy entry' };
    if (MUTATING.test(key) && reason !== 'named' && !reason.startsWith('pending named budget'))
      return { violation: 'is an anonymous write without a named throttle budget' };
    return 'public';
  }
  if (PLATFORM_PREFIX.test(key)) {
    if (!route.hasPlatformGuard)
      return { violation: 'is a platform route without PlatformAdminGuard' };
    if (!route.hasPlatformPermission && PLATFORM_SELF_ROUTES[key] === undefined)
      return { violation: 'is a platform route without @RequirePlatformPermission' };
    return 'platform';
  }
  if (ORG_PREFIX.test(key)) {
    if (!route.hasCapability)
      return { violation: 'is organization-scoped without @RequireCapability' };
    return 'org';
  }
  if (SESSION_ONLY_ROUTES[key] !== undefined) return 'session-only';
  return { violation: 'has no authorization class (not public, org, platform or session-only)' };
}

/** Every census violation across a route set, plus reviewed entries that match no live route. */
export function censusViolations(routes: readonly CensusRoute[]): string[] {
  const out: string[] = [];
  for (const route of routes) {
    const result = classifyRoute(route);
    if (typeof result !== 'string')
      out.push(`${route.key} (${route.handlerKey}) ${result.violation}`);
  }
  const live = new Set(routes.map((r) => r.key));
  for (const list of [PUBLIC_ROUTES, SESSION_ONLY_ROUTES, PLATFORM_SELF_ROUTES]) {
    for (const key of Object.keys(list))
      if (!live.has(key)) out.push(`${key} is listed but no longer exists`);
  }
  return out;
}
