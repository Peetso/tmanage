/**
 * AI action registry — the `platform.*` op family (ADR-0015 part 2, points 5–8, review F1–F11).
 *
 * Owner 2026-11-23: "the MCP connected to a site admin should be able to access the admin platform
 * and any action in it". Every `/v1/platform/*` route (`PlatformAdminGuard`) becomes an op built
 * here, so the rules are decided by construction, once (AR-8), and not per lane file:
 *
 * - **Permission.** `platformPermission` is the route's own `@RequirePlatformPermission` (`null`
 *   only for `GET /v1/platform/me`). `registry-sync.test.ts` checks it against the route.
 * - **Capability** is `null`: no organization role reaches the platform (guard rules 1–5).
 * - **Risk and scope by method.** A `GET` is `read`/`read`. Every other method is
 *   `confirm`/`manage`: frozen in `pending_ai_actions` and run once, after the person confirms it
 *   on the card or the approve page (LLM06-6). Nothing on the platform runs at once.
 * - **Fresh re-authentication (F5).** The changes that can harm every company or hand out power
 *   carry `freshReauth`: the card and the approve page then ask for the password again (the
 *   `x-reauth-token` of the money and HR changes, minutes, not the platform step-up's hours).
 *   The set is {@link PLATFORM_FRESH_REAUTH_ROUTES} plus every change that needs a permission in
 *   {@link PLATFORM_FRESH_REAUTH_PERMISSIONS} (the admin team and presets, the two-person policy,
 *   a company's roles and a member's permission overrides).
 */
import { z } from 'zod';
import type { PlatformPermission } from '@tmanage/domain';
import type { AiActionOp, HttpMethod } from './types.js';
import { routeKey } from './types.js';

export const PLATFORM_BASE = '/v1/platform';

/**
 * F5 — the platform changes approved only with a fresh re-authentication, by route key. Reviewed
 * as one list (Fable 5.2 review F5): `RISKY_PLATFORM_ACTIONS` (suspend, delete, transfer
 * ownership), suspension and reactivation of a company, deletion and purge, ownership transfer, a
 * member's role and permission overrides set by the platform, a support visit started or extended,
 * a password reset, a sign-out, a session ended, two-step reset or required, a person disabled or
 * enabled, the network-access rules, the AI access switch and the AI budget, a company's AI test
 * entry and credit packs, a company's plan, billing mode, public sign-up, data retention, the integration switches and key
 * rotation.
 */
export const PLATFORM_FRESH_REAUTH_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/platform/companies/:organizationId/suspension',
  'POST /v1/platform/companies/:organizationId/reactivation',
  'POST /v1/platform/organizations/:organizationId/suspension',
  'POST /v1/platform/organizations/:organizationId/reactivation',
  'POST /v1/platform/organizations/:organizationId/deletion',
  'POST /v1/platform/organizations/:organizationId/purge',
  'POST /v1/platform/organizations/:organizationId/ownership-transfer',
  'PUT /v1/platform/organizations/:organizationId/members/:membershipId/role',
  'PUT /v1/platform/organizations/:organizationId/members/:membershipId/permissions/overrides',
  'PUT /v1/platform/organizations/:organizationId/plan',
  'POST /v1/platform/organizations/:id/support-session',
  'POST /v1/platform/support-sessions/:id/extend',
  'POST /v1/platform/people/:userId/password-reset',
  'POST /v1/platform/people/:userId/sign-out',
  'POST /v1/platform/people/:userId/disable',
  'POST /v1/platform/people/:userId/enable',
  'POST /v1/platform/people/:userId/two-step/reset',
  'PUT /v1/platform/people/:userId/two-step/required',
  'DELETE /v1/platform/people/:userId/sessions/:sessionId',
  'DELETE /v1/platform/activity/access/sessions/:sessionId',
  'POST /v1/platform/security/network-access/allowlist',
  'DELETE /v1/platform/security/network-access/allowlist/:id',
  'POST /v1/platform/security/network-access/blocklist',
  'DELETE /v1/platform/security/network-access/blocklist/:id',
  'PUT /v1/platform/security/network-access/policy',
  'PUT /v1/platform/settings/ai-access',
  'PUT /v1/platform/settings/ai-budget/',
  'POST /v1/platform/settings/ai-budget/pause',
  'POST /v1/platform/settings/ai-budget/resume',
  'POST /v1/platform/settings/ai-budget/reserve-release',
  'PUT /v1/platform/ai/test-list/:organizationId',
  'POST /v1/platform/ai/test-list/:organizationId/packs',
  'PUT /v1/platform/settings/billing-mode',
  'PUT /v1/platform/settings/public-signup',
  'PUT /v1/platform/settings/retention',
  'POST /v1/platform/approvals/:id/approve',
  // Lane C review: `mcp` turns this AI connector itself on or off, like `settings/ai-access`.
  'PUT /v1/platform/settings/integrations/:integration',
  // F7: key rotation (no raw key is read or shown; the worker re-encrypts with the new key).
  'POST /v1/platform/keys/rotate',
]);

/**
 * F9 — the platform changes that also need a different admin's approval while the two-person
 * policy is on (`@RequireTwoPersonApproval`, `RISKY_PLATFORM_ACTIONS`). The card says so.
 * `platform-admin-ai.test.ts` checks this set against the routes' own metadata.
 */
export const PLATFORM_TWO_PERSON_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/platform/companies/:organizationId/suspension',
  'POST /v1/platform/organizations/:organizationId/suspension',
  'POST /v1/platform/organizations/:organizationId/deletion',
  'POST /v1/platform/organizations/:organizationId/ownership-transfer',
]);

/**
 * F5 by permission: every change that hands out power — the platform admin team, its presets and
 * the two-person policy (`platform.team.manage`), and a company's roles, role matrix and a
 * member's permission overrides (`platform.permissions.edit`).
 */
export const PLATFORM_FRESH_REAUTH_PERMISSIONS: ReadonlySet<PlatformPermission> = new Set([
  'platform.team.manage',
  'platform.permissions.edit',
]);

/** Whether a platform route's change needs the fresh re-authentication (F5). */
export function platformNeedsFreshReauth(
  method: HttpMethod,
  path: string,
  permission: PlatformPermission | null,
): boolean {
  if (method === 'GET') return false;
  if (permission !== null && PLATFORM_FRESH_REAUTH_PERMISSIONS.has(permission)) return true;
  return PLATFORM_FRESH_REAUTH_ROUTES.has(routeKey(method, path));
}

/**
 * One platform op. `subPath` is the route path after `/v1/platform` exactly as the controller
 * declares it (a root route keeps its trailing slash: `/alerts/`). Risk, scope and the F5 flag
 * follow from the method and the route; a lane file never chooses them.
 */
export function pop(
  id: string,
  method: HttpMethod,
  subPath: string,
  platformPermission: PlatformPermission | null,
  /** Arguments a non-GET route reads from its query string (`?kind=`), see `AiActionOp`. */
  options: { readonly queryArgs?: readonly string[] } = {},
): AiActionOp {
  const path = `${PLATFORM_BASE}${subPath}`;
  const read = method === 'GET';
  return {
    id,
    method,
    path,
    capability: null,
    risk: read ? 'read' : 'confirm',
    scope: read ? 'read' : 'manage',
    platformPermission,
    ...(platformNeedsFreshReauth(method, path, platformPermission)
      ? { freshReauth: true as const }
      : {}),
    ...(options.queryArgs !== undefined && !read ? { queryArgs: options.queryArgs } : {}),
  };
}

// ---- Shared field builders for the platform lane files (mirroring `platform-admin.access.ts`) ----

/** `platform-admin.access.ts` UUID_SHAPE (`requireId`): every platform path id is a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const pf = {
  uuid: () => z.string().regex(UUID),
  /** `requireReason`: 5–500 characters, required on the destructive list. */
  reason: () => z.string().trim().min(5).max(500),
  /** `optionalReason`: at most 500 characters. */
  optionalReason: () => z.string().max(500).optional(),
  day: () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
} as const;

/** Example ids for the descriptions' worked examples. */
export const PU1 = '3f2b6c1e-8a4d-4e2f-9b1a-2c3d4e5f6a7b';
export const PU2 = '7a1d2e3f-4b5c-4d6e-8f9a-0b1c2d3e4f5a';
