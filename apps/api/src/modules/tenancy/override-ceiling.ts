import { CAPABILITIES, isPlatformSupportRole, mayGrantCapability } from '@tmanage/domain';
import type { Capability, Principal, PrincipalRole } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { requireClientCeiling } from './role-grant-ceiling.js';

/**
 * platform-admin v2 · PA-01 — the one rule for "may this caller set these per-member overrides?"
 * (SPEC §3.3 "Per-member overrides").
 *
 * The same shape as `role-grant-ceiling.ts`: every path that writes
 * `membership_permission_overrides` (the org-side Members & roles page, the platform-side
 * permission editor in PA-04) asks this file, so the rules cannot drift between them.
 *
 * - An `allow` may only name a capability the granter can exercise org-wide
 *   (`mayGrantCapability`, the same subset rule custom roles use). A `deny` takes something away
 *   and needs only `roles.assign`, which the route already required.
 * - Overrides on an **owner** are refused: "Owners always have every permission".
 * - A `deny` never applies to `platform_support` (the hidden Support-session role), so writing
 *   one is refused rather than stored to no effect.
 * - A client membership can be allowed only capabilities inside the 56-28 client ceiling
 *   (`CLIENT_CAPABILITY_ALLOWLIST`, 422 `client_ceiling`); storing the rest would mislead the
 *   screen. A deny on a client member stays allowed.
 */

export type OverrideEffect = 'allow' | 'deny';

export interface OverrideInput {
  readonly capability: string;
  readonly effect: string;
  readonly reason?: string | null;
  readonly expiresAt?: string | null;
}

export interface ValidOverride {
  readonly capability: Capability;
  readonly effect: OverrideEffect;
  readonly reason: string | null;
  readonly expiresAt: Date | null;
}

/** The member the overrides are for, as the repository loaded it. */
export interface OverrideTarget {
  readonly role: string;
  readonly audience: 'internal' | 'client';
}

export const OWNER_OVERRIDE_MESSAGE = 'Owners always have every permission';

/** The longest reason the column holds (`VARCHAR(500)`). */
export const OVERRIDE_REASON_MAX = 500;

/** How many overrides one member may carry; the matrix has 56 cells, so this is generous. */
export const OVERRIDES_PER_MEMBER_MAX = 112;

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The overrides are invalid.', [{ field, message }]);
}

/**
 * Parse and validate the overrides body, without the caller-dependent ceiling (that is
 * {@link requireMayOverride}). Duplicate capabilities and malformed values are a 400.
 */
export function parseOverrides(body: unknown, now: Date = new Date()): readonly ValidOverride[] {
  const list = (body as { overrides?: unknown } | null)?.overrides;
  if (!Array.isArray(list)) throw invalid('overrides', 'must be a list');
  if (list.length > OVERRIDES_PER_MEMBER_MAX) {
    throw invalid('overrides', `must hold at most ${OVERRIDES_PER_MEMBER_MAX} entries`);
  }
  const seen = new Set<string>();
  return list.map((raw: unknown, index) => {
    const entry = (raw ?? {}) as Partial<Record<keyof OverrideInput, unknown>>;
    const field = `overrides[${index}]`;
    const capability = entry.capability;
    if (typeof capability !== 'string' || !KNOWN.has(capability)) {
      throw invalid(`${field}.capability`, 'must be a known permission');
    }
    if (seen.has(capability)) throw invalid(`${field}.capability`, 'is listed twice');
    seen.add(capability);
    const effect = entry.effect;
    if (effect !== 'allow' && effect !== 'deny') {
      throw invalid(`${field}.effect`, 'must be allow or deny');
    }
    let reason: string | null = null;
    if (entry.reason !== undefined && entry.reason !== null) {
      if (typeof entry.reason !== 'string') throw invalid(`${field}.reason`, 'must be text');
      const trimmed = entry.reason.trim();
      if (trimmed.length > OVERRIDE_REASON_MAX) {
        throw invalid(`${field}.reason`, `must be at most ${OVERRIDE_REASON_MAX} characters`);
      }
      reason = trimmed === '' ? null : trimmed;
    }
    let expiresAt: Date | null = null;
    if (entry.expiresAt !== undefined && entry.expiresAt !== null) {
      const parsed = typeof entry.expiresAt === 'string' ? new Date(entry.expiresAt) : null;
      if (parsed === null || Number.isNaN(parsed.getTime())) {
        throw invalid(`${field}.expiresAt`, 'must be a date and time');
      }
      if (parsed.getTime() <= now.getTime()) {
        throw invalid(`${field}.expiresAt`, 'must be in the future');
      }
      expiresAt = parsed;
    }
    return { capability: capability as Capability, effect, reason, expiresAt };
  });
}

/**
 * Refuse, before any write, an override set the caller may not place on this member.
 * 400 for an owner or a deny on the Support-session role; 403 for an allow beyond the caller.
 */
export function requireMayOverride(
  principal: Principal,
  target: OverrideTarget,
  overrides: readonly ValidOverride[],
  organizationId: string,
  action: string,
): void {
  if (target.audience === 'internal' && target.role === 'owner') {
    throw new ApiError(
      400,
      'validation_failed',
      OWNER_OVERRIDE_MESSAGE,
      undefined,
      `${action}:owner`,
    );
  }
  for (const [index, override] of overrides.entries()) {
    const field = `overrides[${index}].capability`;
    if (
      override.effect === 'deny' &&
      target.audience === 'internal' &&
      isPlatformSupportRole(target.role)
    ) {
      throw new ApiError(
        400,
        'validation_failed',
        'A deny never applies to TManage support.',
        [{ field, message: 'remove this deny' }],
        `${action}:platform_support_deny`,
      );
    }
    // R23-b (56-28): an `allow` on a client member holds the client ceiling (422 `client_ceiling`
    // naming the capability); a `deny` only takes away, so it stays allowed. A capability the
    // vocabulary does not know is still the 400 below.
    if (target.audience === 'client' && override.effect === 'allow') {
      requireClientCeiling(
        target.role as PrincipalRole,
        [override.capability],
        `${action}:client_allow`,
      );
    }
    if (target.audience === 'client' && !KNOWN.has(override.capability)) {
      throw new ApiError(
        400,
        'validation_failed',
        'Client members can only be given client permissions.',
        [{ field, message: 'not available to a client member' }],
        `${action}:internal_only`,
      );
    }
    if (override.effect === 'allow') {
      const verdict = mayGrantCapability(principal, override.capability, organizationId);
      if (!verdict.allowed) {
        throw new ApiError(
          403,
          'forbidden',
          'You can only give a permission you hold yourself.',
          [{ field, message: 'you do not hold this permission' }],
          `${action}:override_exceeds_ceiling`,
        );
      }
    }
  }
}
