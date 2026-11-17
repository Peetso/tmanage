import { Inject, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import { requestState } from '../../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import { PlatformAdminRepository } from '../platform-admin.repository.js';

/**
 * 51-15p — the platform kill switch of one connected service, enforced on the server.
 *
 * The switch is the `platform_settings['integration.<key>']` row the platform settings page
 * already writes (absent or `on` = on, `off` = off). Every connect, sign-in completion and use
 * route of a service carries {@link RequireIntegrationOn}; while it is off they answer the same
 * 409 `conflict` shape as "not set up yet", detail `switched_off`. Status reads and disconnects
 * stay open: switching a service off never deletes a connection, and switching it on restores it.
 * MCP keeps its own AI kill switch (`ai_access`, oauth/ai-access.ts), which is the same row.
 *
 * Reads are cached {@link INTEGRATION_SWITCH_CACHE_MS} per process; the process that flips a
 * switch forgets at once. A failed read counts as off: a kill switch fails closed.
 */

/** The services with a platform switch here (MCP and e-mail are not among them). */
export const SWITCHABLE_INTEGRATIONS = [
  'google_drive',
  'onedrive',
  'google_calendar',
  'microsoft_calendar',
  'figma',
  'github',
  'jira',
] as const;

export type SwitchableIntegration = (typeof SWITCHABLE_INTEGRATIONS)[number];

export const INTEGRATION_SWITCH_CACHE_MS = 500;

export function isSwitchableIntegration(value: unknown): value is SwitchableIntegration {
  return (
    typeof value === 'string' && (SWITCHABLE_INTEGRATIONS as readonly string[]).includes(value)
  );
}

export function switchSettingKey(key: SwitchableIntegration): string {
  return `integration.${key}`;
}

/** The refusal while a service is switched off for the whole platform. */
export function integrationSwitchedOff(key: SwitchableIntegration): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This service is turned off for TManage right now',
    [{ field: 'integration', message: 'switched_off' }],
    `integration.${key}_off`,
  );
}

export interface IntegrationSwitches {
  isOn(key: SwitchableIntegration, correlationId: string): Promise<boolean>;
  forget(): void;
}

export function createIntegrationSwitchesFrom(
  read: (settingKey: string, correlationId: string) => Promise<string | null>,
  now: () => number = () => Date.now(),
): IntegrationSwitches {
  const cache = new Map<SwitchableIntegration, { readonly on: boolean; readonly at: number }>();
  return {
    async isOn(key, correlationId) {
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.at < INTEGRATION_SWITCH_CACHE_MS) return hit.on;
      let on: boolean;
      try {
        on = (await read(switchSettingKey(key), correlationId)) !== 'off';
      } catch {
        on = false;
      }
      cache.set(key, { on, at: now() });
      return on;
    },
    forget() {
      cache.clear();
    },
  };
}

const processSwitches = new WeakMap<TenantDatabase, IntegrationSwitches>();
const allSwitches = new Set<IntegrationSwitches>();

/** The process-wide switches over one database (one cache, so a flip here is seen at once). */
export function integrationSwitches(database: TenantDatabase): IntegrationSwitches {
  let switches = processSwitches.get(database);
  if (switches === undefined) {
    const repository = new PlatformAdminRepository(database);
    switches = createIntegrationSwitchesFrom((key, correlationId) =>
      repository.readSetting(key, correlationId),
    );
    processSwitches.set(database, switches);
    allSwitches.add(switches);
  }
  return switches;
}

/** Called by the settings page after it wrote a switch. */
export function forgetIntegrationSwitches(): void {
  for (const switches of allSwitches) switches.forget();
}

/** Throws {@link integrationSwitchedOff} while `key` is off. The one shared check. */
export async function requireIntegrationOn(
  switches: IntegrationSwitches,
  key: SwitchableIntegration,
  correlationId: string,
): Promise<void> {
  if (!(await switches.isOn(key, correlationId))) throw integrationSwitchedOff(key);
}

/**
 * ADMINSVC2 — the one gate every background job asks before it touches a connected service.
 * `false` while the service is off (or the switch cannot be read): the job skips this round
 * quietly — no error state, no retry, nothing deleted — and works again on its next pass once the
 * service is on. A harness database without the identity reader counts as on, as in
 * admin/feature-gate.ts, so unit harnesses of a job need no platform tables.
 */
export async function integrationOnForJob(
  database: TenantDatabase,
  key: SwitchableIntegration,
  correlationId: string,
): Promise<boolean> {
  if (typeof database.identityRead !== 'function') return true;
  return integrationSwitches(database).isOn(key, correlationId);
}

/** A fixed service, or the route parameter that names it (`:provider`, `:connectorKey`). */
export type IntegrationTarget = SwitchableIntegration | { readonly param: string };

const REQUIRED_INTEGRATION = Symbol('tmanage.route.integration');

/** The service a request targets, or `null` when the parameter names no switchable service. */
export function targetIntegration(
  target: IntegrationTarget,
  params: Readonly<Record<string, unknown>> | undefined,
): SwitchableIntegration | null {
  if (typeof target === 'string') return target;
  const value = params?.[target.param];
  const normalised = typeof value === 'string' ? value.replace(/-/g, '_') : value;
  return isSwitchableIntegration(normalised) ? normalised : null;
}

@Injectable()
export class IntegrationSwitchGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const target = this.reflector.getAllAndOverride<IntegrationTarget | undefined>(
      REQUIRED_INTEGRATION,
      [execution.getHandler(), execution.getClass()],
    );
    if (target === undefined) return true;
    const request = execution
      .switchToHttp()
      .getRequest<{ readonly params?: Readonly<Record<string, unknown>> }>();
    const key = targetIntegration(target, request.params);
    if (key === null) return true;
    await requireIntegrationOn(
      integrationSwitches(this.database),
      key,
      requestState(request)?.correlationId ?? '',
    );
    return true;
  }
}

/**
 * Put a connect, sign-in completion or use route behind the service's platform switch. Runs after
 * the global pipeline (session, tenant, capability), so it only narrows what a caller may reach.
 */
export const RequireIntegrationOn = (target: IntegrationTarget): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRED_INTEGRATION, target), UseGuards(IntegrationSwitchGuard));
