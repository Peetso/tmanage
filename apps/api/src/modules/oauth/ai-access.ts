import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { requestState } from '../../common/http/request-state.js';
import { PlatformAdminRepository } from '../platform-admin/platform-admin.repository.js';
import { findAiAppsOffRow } from './grants.repository.js';

/**
 * **The AI kill switches above the single connection (MCP connector S11; architecture F4).**
 *
 * - **Workspace:** an owner turns "Allow AI apps in this workspace" off. Every AI request for that
 *   organization is then refused with 403 (`ai_disabled`): `/mcp`, token exchange and refresh, and
 *   new consents. Grants are kept, so turning the switch back on restores them. Stored as the
 *   `ai_apps_off` row of `org_feature_flags` (0147): absence of a row is "AI allowed", the default,
 *   so no migration is needed and the Modules screen (which folds only its own allowlist) never
 *   shows it.
 * - **Platform:** the operator's `platform_settings.ai_access = 'off'`, or the environment variable
 *   `TMANAGE_MCP_DISABLED=1`. `/mcp` and the OAuth endpoints then answer 503. Revocation stays open
 *   on purpose: switching AI off must never stop someone disconnecting an app.
 *
 * Both reads are cached for {@link AI_SWITCH_CACHE_MS} per process, so a flip takes effect on the
 * next call within one second (`T-KILL-01`), and the process that made the flip forgets at once.
 * A failed read is treated as **off**: a kill switch fails closed.
 */

/** The `org_feature_flags.flag_key` of the workspace switch. `enabled = 1` means AI is OFF. */
export const AI_APPS_OFF_FLAG = 'ai_apps_off';
/** The `platform_settings.setting_key` of the platform switch. */
export const PLATFORM_AI_ACCESS_SETTING = 'ai_access';
/** How long one process may reuse a switch read. Below the 1 s the plan promises. */
export const AI_SWITCH_CACHE_MS = 500;

export const AI_ACCESS_SWITCHES = Symbol.for('tmanage.AiAccessSwitches');

/** Why the workspace switch is read before a tenant context exists (token and `/mcp` paths). */
export const AI_SWITCH_BOOTSTRAP_REASON =
  'reading the workspace AI kill switch for the organization a presented AI credential is bound to';

/** The platform switch from its stored value and the environment. Pure. */
export function platformAiAccessOn(stored: string | null, environmentDisabled: boolean): boolean {
  if (environmentDisabled) return false;
  return stored !== 'off';
}

/** The workspace switch from its `ai_apps_off` row (`null` when there is none). Pure. */
export function organizationAiAccessOn(
  aiAppsOffRow: { readonly enabled: boolean } | null,
): boolean {
  return aiAppsOffRow === null || !aiAppsOffRow.enabled;
}

/** Is `TMANAGE_MCP_DISABLED` set to turn the connector off? */
export function environmentAiDisabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export interface AiAccessSwitches {
  platformOn(correlationId: string): Promise<boolean>;
  organizationOn(organizationId: string, correlationId: string): Promise<boolean>;
  /** Drop cached reads after this process changed a switch. */
  forget(): void;
}

interface Readers {
  readonly readPlatform: (correlationId: string) => Promise<string | null>;
  readonly readOrganization: (
    organizationId: string,
    correlationId: string,
  ) => Promise<{ readonly enabled: boolean } | null>;
  readonly environmentDisabled: boolean;
  readonly now?: () => number;
}

/** The switches over two readers, with the short cache. Exported for the unit tests. */
export function createAiAccessSwitchesFrom(readers: Readers): AiAccessSwitches {
  const now = readers.now ?? (() => Date.now());
  const cache = new Map<string, { readonly on: boolean; readonly at: number }>();
  async function cached(key: string, read: () => Promise<boolean>): Promise<boolean> {
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < AI_SWITCH_CACHE_MS) return hit.on;
    let on: boolean;
    try {
      on = await read();
    } catch {
      on = false;
    }
    cache.set(key, { on, at: now() });
    return on;
  }
  return {
    platformOn(correlationId) {
      if (readers.environmentDisabled) return Promise.resolve(false);
      return cached('platform', async () =>
        platformAiAccessOn(await readers.readPlatform(correlationId), false),
      );
    },
    organizationOn(organizationId, correlationId) {
      return cached(`org:${organizationId}`, async () =>
        organizationAiAccessOn(await readers.readOrganization(organizationId, correlationId)),
      );
    },
    forget() {
      cache.clear();
    },
  };
}

/** The production switches over the database. */
export function createAiAccessSwitches(
  database: TenantDatabase,
  environmentDisabled: boolean,
): AiAccessSwitches {
  const platform = new PlatformAdminRepository(database);
  return createAiAccessSwitchesFrom({
    environmentDisabled,
    readPlatform: (correlationId) =>
      platform.readSetting(PLATFORM_AI_ACCESS_SETTING, correlationId),
    readOrganization: (organizationId, correlationId) =>
      database.bootstrapRead(
        { correlationId, reason: AI_SWITCH_BOOTSTRAP_REASON, tables: ['org_feature_flags'] },
        (db) => findAiAppsOffRow(db, organizationId, AI_APPS_OFF_FLAG),
      ),
  });
}

/** The 503 every AI surface answers while the platform switch is off. */
export function aiPlatformDisabledError(): ApiError {
  return new ApiError(
    503,
    'internal_error',
    'AI access is turned off.',
    undefined,
    'ai_access_disabled',
  );
}

/** The 403 every AI request for a workspace answers while its owner has AI turned off. */
export function aiWorkspaceDisabledError(): ApiError {
  return new ApiError(
    403,
    'forbidden',
    'AI apps are turned off for this workspace.',
    undefined,
    'ai_disabled',
  );
}

/** Refuses the route with 503 while the platform switch is off. Used on the OAuth endpoints. */
@Injectable()
export class AiPlatformSwitchGuard implements CanActivate {
  constructor(@Inject(AI_ACCESS_SWITCHES) private readonly switches: AiAccessSwitches) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const state = requestState(context.switchToHttp().getRequest<object>());
    if (!(await this.switches.platformOn(state?.correlationId ?? ''))) {
      throw aiPlatformDisabledError();
    }
    return true;
  }
}

/**
 * The AI kill switches (S11): one per module that enforces them. `TMANAGE_MCP_DISABLED=1` turns
 * the connector off for the whole platform regardless of the stored setting.
 */
export const aiAccessSwitchesProvider: Provider = {
  provide: AI_ACCESS_SWITCHES,
  inject: [TENANT_DATABASE],
  useFactory: (database: TenantDatabase): AiAccessSwitches =>
    createAiAccessSwitches(database, environmentAiDisabled(process.env['TMANAGE_MCP_DISABLED'])),
};
