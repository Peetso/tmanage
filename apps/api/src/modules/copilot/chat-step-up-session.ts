import type { TenantContext } from '../../common/database/tenant-context.js';

/**
 * ADR-0015 part 2 (point 7b, review F3) — the browser session an in-app chat request runs in, for
 * the step-up binding of its platform calls. The chat controller binds it from the request's own
 * proved cookie session (never from a header, the body or the model) to the request's tenant
 * context object; the tool surface reads it back for the same object when it mints the inner
 * grants. Keyed by the context object, so it lives exactly as long as the request: a context the
 * controller did not bind (a background job, a test, a non-cookie caller) has none, and its
 * platform calls are refused by `PlatformAdminGuard` (fail closed).
 */
const SESSIONS = new WeakMap<TenantContext, string>();

/** Bind a cookie request's session; anything but a cookie session binds nothing. */
export function bindChatStepUpSession(
  context: TenantContext,
  authScheme: string | undefined,
  sessionId: string | undefined,
): void {
  if (authScheme === 'cookie' && typeof sessionId === 'string' && sessionId !== '') {
    SESSIONS.set(context, sessionId);
  }
}

/** The bound cookie session of this request's context, if any. */
export function chatStepUpSessionOf(context: TenantContext): string | undefined {
  return SESSIONS.get(context);
}
