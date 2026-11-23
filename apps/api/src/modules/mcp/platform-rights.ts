import type { Provider } from '@nestjs/common';
import type { ApiConfig } from '../../common/http/api-config.js';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PlatformAdminRepository } from '../platform-admin/platform-admin.repository.js';
import {
  resolvePlatformAdmin,
  type PlatformAdminLookup,
} from '../platform-admin/platform-admin.guard.js';
import {
  PLATFORM_CONSENT_CHECK,
  PLATFORM_CONSENT_STEP_UP_FRESH_MS,
  type PlatformConsentCheck,
  type PlatformConsentStanding,
} from '../oauth/consent.js';

/**
 * ADR-0015 part 2 (point 6) — the account's platform rights for the AI catalogue, decided by the
 * guard's own rule 1 and rule 3 (`resolvePlatformAdmin`, AR-8), so a `platform.*` op is listed
 * exactly when `PlatformAdminGuard` would let the account through on permissions. The step-up is
 * not checked here: an op is listed for an admin without a live step-up, and the guard answers
 * 403 `reauthentication_required`, so the AI can say "step up first" (the ADR's `me` rationale).
 *
 * Only callers that already hold a step-up binding ask: the in-app chat (its cookie session), and
 * the `/mcp` endpoint for an OAuth grant with `tmanage:platform` inside its window. A personal
 * access token is never asked about (F2), so its catalogue never holds a platform op.
 */
export interface AiPlatformRights {
  /** The account's platform permissions, or `undefined` when it is no platform admin. */
  permissionsFor(userId: string, correlationId: string): Promise<ReadonlySet<string> | undefined>;
}

export const AI_PLATFORM_RIGHTS = Symbol.for('tmanage.AiPlatformRights');

export function platformRightsFrom(
  allowlist: readonly string[],
  lookup: PlatformAdminLookup,
): AiPlatformRights {
  return {
    async permissionsFor(userId, correlationId) {
      if (allowlist.length === 0) {
        const anyTeam = lookup.hasActivePlatformAdmins
          ? await lookup.hasActivePlatformAdmins(correlationId)
          : false;
        if (!anyTeam) return undefined;
      }
      const resolved = await resolvePlatformAdmin(allowlist, lookup, userId, correlationId);
      return resolved.ok ? new Set<string>(resolved.permissions) : undefined;
    },
  };
}

/**
 * ADR-0015 F11 — what the consent page may offer about `tmanage:platform`: only to a platform
 * admin, and tickable only with two-step sign-in on (where the guard requires it) and a step-up in
 * this very browser session no older than {@link PLATFORM_CONSENT_STEP_UP_FRESH_MS}.
 */
export function platformConsentCheckFrom(
  allowlist: readonly string[],
  lookup: PlatformAdminLookup,
  twoStepRequired: boolean,
  now: () => Date = () => new Date(),
): PlatformConsentCheck {
  const rights = platformRightsFrom(allowlist, lookup);
  return {
    async standing(userId, sessionId, correlationId): Promise<PlatformConsentStanding> {
      const permissions = await rights.permissionsFor(userId, correlationId);
      if (permissions === undefined) return { offered: false, ready: false, stepUpExpiresAt: null };
      const account = await lookup.findAccount(userId, correlationId);
      const stepUp = await lookup.findLiveStepUp(userId, sessionId, correlationId);
      const fresh =
        stepUp !== null &&
        stepUp.createdAt !== undefined &&
        now().getTime() - stepUp.createdAt.getTime() <= PLATFORM_CONSENT_STEP_UP_FRESH_MS;
      const twoStepOk = !twoStepRequired || account?.mfaEnabled === true;
      return {
        offered: true,
        ready: fresh && twoStepOk,
        stepUpExpiresAt: stepUp?.expiresAt ?? null,
      };
    },
  };
}

/** The production rights reader: the platform repository and the server list. */
export const aiPlatformRightsProvider: Provider = {
  provide: AI_PLATFORM_RIGHTS,
  inject: [TENANT_DATABASE, API_CONFIG],
  useFactory: (database: TenantDatabase, config: ApiConfig) =>
    platformRightsFrom(config.platformAdminEmails ?? [], new PlatformAdminRepository(database)),
};

/** The production consent check (F11). */
export const platformConsentCheckProvider: Provider = {
  provide: PLATFORM_CONSENT_CHECK,
  inject: [TENANT_DATABASE, API_CONFIG],
  useFactory: (database: TenantDatabase, config: ApiConfig) =>
    platformConsentCheckFrom(
      config.platformAdminEmails ?? [],
      new PlatformAdminRepository(database),
      // F11: an external AI reaching Platform admin always needs two-step sign-in, whatever
      // PLATFORM_STAFF_TWO_STEP says for the person's own screen.
      true,
    ),
};
