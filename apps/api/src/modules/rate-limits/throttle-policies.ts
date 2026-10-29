import { SetMetadata } from '@nestjs/common';
import type { ThrottleLimits, ThrottlePolicy } from './durable-rate-limiter.js';

/**
 * 56-05 — which budget each anonymous route is charged to.
 *
 * The plan's acceptance is "every anonymous route has a `@Throttle`". Two ways a route gets one:
 *
 * 1. **`@Throttle(name, limits)`** on the handler or controller — the plan's decorator, for new
 *    routes (56-07's public links, 52-20's intake form) whose author picks the budget in place.
 * 2. **{@link PUBLIC_ROUTE_POLICIES}**, keyed `Controller.handler`, for the anonymous routes that
 *    existed before this item. Kept here, not as decorators on those controllers, so this item
 *    edits none of the files other lanes own; a decorator on the handler wins over an entry here.
 *
 * Any other `@Public()` route is charged to {@link DEFAULT_PUBLIC_POLICY}, so a new anonymous route
 * nobody annotated is still limited — the default is safe, the same direction `@Public()` itself
 * takes. Routes behind a session are not limited here at all (plan: "my own team never hits a
 * limit during normal work"); member quotas are `org-quotas.ts`.
 */

export const THROTTLE_POLICY = Symbol('tmanage.route.throttle');

/** `@Throttle('intake_submit', { perMinute: 10, perHour: 60, key: 'ip+link' })`. */
export const Throttle = (name: string, limits: ThrottleLimits): MethodDecorator & ClassDecorator =>
  SetMetadata(THROTTLE_POLICY, { name, ...limits } satisfies ThrottlePolicy);

/** Any anonymous route with no policy of its own: generous for a person, a wall for a script. */
export const DEFAULT_PUBLIC_POLICY: ThrottlePolicy = {
  name: 'public_default',
  perMinute: 120,
  perHour: 2_000,
  key: 'ip',
  onStoreError: 'open',
};

/** Ready for 52-20 / 56-07 to put on their routes with `@Throttle(...)`. */
export const INTAKE_SUBMIT_LIMITS: ThrottleLimits = {
  perMinute: 10,
  perHour: 60,
  key: 'ip+link',
  onStoreError: 'closed',
};
export const PUBLIC_LINK_VIEW_LIMITS: ThrottleLimits = {
  perMinute: 60,
  perHour: 600,
  key: 'ip',
  onStoreError: 'closed',
};
export const CSP_REPORT_LIMITS: ThrottleLimits = {
  perMinute: 30,
  perHour: 300,
  key: 'ip',
  onStoreError: 'open',
};
export const INBOUND_WEBHOOK_LIMITS: ThrottleLimits = {
  perMinute: 300,
  perHour: 6_000,
  key: 'link',
  linkParam: 'endpointId',
  onStoreError: 'open',
};

const writeDoor = (name: string, perMinute: number, perHour: number): ThrottlePolicy => ({
  name,
  perMinute,
  perHour,
  key: 'ip',
  onStoreError: 'closed',
});

const sharedSignIn = writeDoor('sign_in', 30, 300);
const sharedOAuth = writeDoor('oauth_public', 60, 1_200);
const sharedPasswordReset = writeDoor('password_reset', 5, 20);
const sharedSignup = writeDoor('signup', 5, 20);
const sharedInvitation = writeDoor('invitation_accept', 10, 60);
const sharedSetup = writeDoor('setup', 5, 20);

/** `Controller.handler` → policy, for the anonymous routes that predate this item. */
export const PUBLIC_ROUTE_POLICIES: Readonly<Record<string, ThrottlePolicy>> = {
  'ContactController.submit': writeDoor('contact_submit', 5, 20),
  'PublicSignupController.signUp': sharedSignup,
  'PasswordResetController.request': sharedPasswordReset,
  'PasswordResetController.complete': sharedPasswordReset,
  'FirstOwnerController.setup': sharedSetup,
  'InvitationAcceptanceController.preview': sharedInvitation,
  'InvitationAcceptanceController.accept': sharedInvitation,
  'InvitationAcceptanceController.register': sharedInvitation,
  'AuthenticationController.signInWithPassword': sharedSignIn,
  'AuthenticationController.completeMfa': sharedSignIn,
  'AuthenticationController.completeWithRecoveryCode': sharedSignIn,
  'OAuthRegisterController.register': sharedOAuth,
  'OAuthTokenController.token': sharedOAuth,
  'OAuthRevokeController.revoke': sharedOAuth,
  // Member traffic that happens to be anonymous: generous, fail-open, never broken by the breaker.
  'SessionController.refresh': {
    name: 'session_refresh',
    perMinute: 60,
    perHour: 1_200,
    key: 'ip',
    onStoreError: 'open',
    breakerExempt: true,
  },
  // Signed part PUTs of an upload a member started: many per file, already bounded per session.
  'UploadPartsController.put': {
    name: 'upload_parts',
    perMinute: 600,
    perHour: 20_000,
    key: 'ip',
    onStoreError: 'open',
    breakerExempt: true,
  },
};
