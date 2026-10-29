import { readFile } from 'node:fs/promises';
import { ApiError } from '../../../common/http/errors.js';
import {
  environmentAiDisabled,
  PLATFORM_AI_ACCESS_SETTING,
  platformAiAccessOn,
} from '../../oauth/ai-access.js';
import { requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  ConnectionCount,
  IntegrationCounts,
  PlatformSettingsRepository,
  StoredSetting,
} from './settings.repository.js';

/**
 * Platform admin · Settings · Integrations (SPEC §4 D1, §5.6).
 *
 * Per integration: whether the server keys are present (read only — they live in Hostinger),
 * whether it is on for TManage (`platform_settings['integration.<key>']`, default on), how many
 * organizations are connected, and the last error / last success. The MCP connector's switch IS
 * the platform AI kill switch (`ai_access`), so the row and the AI access card can never
 * disagree; `TMANAGE_MCP_DISABLED` forces it off ("Forced off by server").
 */

export const INTEGRATION_KEYS = [
  'google_drive',
  'onedrive',
  'google_calendar',
  'microsoft_calendar',
  'mcp',
] as const;

export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

/** The server variables each integration needs. MCP needs none (it is built in). */
export const INTEGRATION_ENVIRONMENT: Readonly<Record<IntegrationKey, readonly string[]>> = {
  google_drive: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  onedrive: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  google_calendar: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft_calendar: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  mcp: [],
};

export function integrationSettingKey(key: IntegrationKey): string {
  return key === 'mcp' ? PLATFORM_AI_ACCESS_SETTING : `integration.${key}`;
}

export function isIntegrationKey(value: unknown): value is IntegrationKey {
  return typeof value === 'string' && (INTEGRATION_KEYS as readonly string[]).includes(value);
}

export interface PlatformIntegrationView {
  readonly key: IntegrationKey;
  /** The server keys are present (read only). */
  readonly configured: boolean;
  /** The variables still missing, for "Add … in Hostinger". */
  readonly missingEnvironment: readonly string[];
  /** On for TManage (effective: off when not configured or forced off by the server). */
  readonly enabled: boolean;
  /** The server switch wins over this page (`TMANAGE_MCP_DISABLED`). */
  readonly environmentForcedOff: boolean;
  readonly connectedOrganizations: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly lastSuccessAt: string | null;
}

/**
 * 51-07 — the in-process worker's heartbeat, for "Background jobs: last batch 23 s ago". Here and
 * not on `/healthz/deep`, which is public and stays ok / fail only.
 */
export interface BackgroundJobsView {
  /** `not_configured` when `OUTBOX_HEARTBEAT_FILE` is unset. */
  readonly worker: 'ok' | 'stale' | 'not_configured';
  readonly lastBatchAt: string | null;
  readonly lastBatchAgeSeconds: number | null;
  readonly maxAgeSeconds: number;
}

export interface PlatformIntegrationsView {
  readonly integrations: readonly PlatformIntegrationView[];
  readonly backgroundJobs: BackgroundJobsView;
}

/** The heartbeat reading as a view. Pure; the age is whole seconds, never negative. */
export function backgroundJobsView(
  env: NodeJS.ProcessEnv,
  lastBatchAt: Date | null,
  now: Date,
): BackgroundJobsView {
  const parsed = Number(env['OUTBOX_HEARTBEAT_MAX_AGE_SECONDS']);
  const maxAgeSeconds = Number.isInteger(parsed) && parsed > 0 ? parsed : 900;
  if (!present(env, 'OUTBOX_HEARTBEAT_FILE')) {
    return {
      worker: 'not_configured',
      lastBatchAt: null,
      lastBatchAgeSeconds: null,
      maxAgeSeconds,
    };
  }
  const age =
    lastBatchAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - lastBatchAt.getTime()) / 1_000));
  return {
    worker: age !== null && age <= maxAgeSeconds ? 'ok' : 'stale',
    lastBatchAt: lastBatchAt?.toISOString() ?? null,
    lastBatchAgeSeconds: age,
    maxAgeSeconds,
  };
}

/** The relay's heartbeat file (`{"lastPollAt": ISO}`), or `null` when absent or unreadable. */
async function readHeartbeatFile(path: string | undefined): Promise<Date | null> {
  if (path === undefined || path.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.trim(), 'utf8'));
    const value =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)['lastPollAt']
        : undefined;
    const at = typeof value === 'string' ? new Date(value) : null;
    return at === null || Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

const EMPTY: ConnectionCount = {
  connected: 0,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastErrorCode: null,
};

function countFor(key: IntegrationKey, counts: IntegrationCounts): ConnectionCount {
  switch (key) {
    case 'google_drive':
      return counts.storage['google_drive'] ?? EMPTY;
    case 'onedrive':
      return counts.storage['onedrive'] ?? EMPTY;
    case 'google_calendar':
      return counts.calendar['google'] ?? EMPTY;
    case 'microsoft_calendar':
      return counts.calendar['microsoft'] ?? EMPTY;
    case 'mcp':
      return counts.grants;
  }
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/** One integration's row from the environment, the stored switch and the counts. Pure. */
export function integrationView(
  key: IntegrationKey,
  env: NodeJS.ProcessEnv,
  stored: StoredSetting | undefined,
  counts: IntegrationCounts,
): PlatformIntegrationView {
  const missingEnvironment = INTEGRATION_ENVIRONMENT[key].filter((name) => !present(env, name));
  const configured = missingEnvironment.length === 0;
  const environmentForcedOff = key === 'mcp' && environmentAiDisabled(env['TMANAGE_MCP_DISABLED']);
  const switchOn =
    key === 'mcp'
      ? platformAiAccessOn(stored?.value ?? null, environmentForcedOff)
      : stored?.value !== 'off';
  const count = countFor(key, counts);
  return {
    key,
    configured,
    missingEnvironment,
    enabled: configured && !environmentForcedOff && switchOn,
    environmentForcedOff,
    connectedOrganizations: count.connected,
    lastErrorCode: count.lastErrorCode,
    lastErrorAt: count.lastErrorAt?.toISOString() ?? null,
    lastSuccessAt: count.lastSuccessAt?.toISOString() ?? null,
  };
}

export class IntegrationsService {
  constructor(
    private readonly store: PlatformSettingsRepository,
    private readonly repository: PlatformAdminRepository,
    private readonly environment?: NodeJS.ProcessEnv,
  ) {}

  private get env(): NodeJS.ProcessEnv {
    return this.environment ?? process.env;
  }

  async list(context: RequestContext): Promise<PlatformIntegrationsView> {
    const rows = await this.store.readAll(context.correlationId);
    const counts = await this.store.integrationCounts(context.correlationId);
    return {
      integrations: INTEGRATION_KEYS.map((key) =>
        integrationView(key, this.env, rows.get(integrationSettingKey(key)), counts),
      ),
      backgroundJobs: backgroundJobsView(
        this.env,
        await readHeartbeatFile(this.env['OUTBOX_HEARTBEAT_FILE']),
        new Date(),
      ),
    };
  }

  /**
   * Turn one integration on or off for every organization. Reason REQUIRED (SPEC P6). An
   * integration without its server keys, or one the server forces off, is a 409 with no write.
   */
  async setEnabled(
    actor: PlatformAdminActor,
    integration: string,
    body: Readonly<Record<string, unknown>>,
    context: RequestContext,
  ): Promise<PlatformIntegrationsView> {
    if (!isIntegrationKey(integration)) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found');
    }
    if (typeof body?.['enabled'] !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
        { field: 'enabled', message: 'must be a boolean' },
      ]);
    }
    const enabled = body['enabled'];
    const reason = requireReason(body['reason']);
    const missing = INTEGRATION_ENVIRONMENT[integration].filter((name) => !present(this.env, name));
    if (missing.length > 0) {
      throw new ApiError(
        409,
        'conflict',
        'This integration has no server keys yet. Add them in Hostinger first.',
        [{ field: 'integration', message: missing.join(', ') }],
      );
    }
    if (integration === 'mcp' && environmentAiDisabled(this.env['TMANAGE_MCP_DISABLED'])) {
      throw new ApiError(409, 'conflict', 'The server switch keeps the MCP connector off.');
    }
    const key = integrationSettingKey(integration);
    await this.repository.writeSetting(
      key,
      enabled ? 'on' : 'off',
      platformAuditFor(actor, context, {
        action: enabled ? 'platform.integration_enabled' : 'platform.integration_disabled',
        targetType: 'setting',
        targetId: null,
        targetLabel: key,
        reason,
        beforeJson: null,
        afterJson: JSON.stringify({ integration, enabled }),
      }),
    );
    return this.list(context);
  }
}
