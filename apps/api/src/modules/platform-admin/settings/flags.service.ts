import { ApiError } from '../../../common/http/errors.js';
import {
  DEFAULT_MODULE_ENABLED,
  FLAG_ROLLOUTS,
  OPTIONAL_MODULE_FLAGS,
  isOptionalModuleFlag,
  parseFlagLocks,
  resolveFlag,
} from '../../admin/feature-flags.service.js';
import type {
  FlagRollout,
  OptionalModuleFlag,
  PlatformFlagContext,
  PlatformFlagLayer,
} from '../../admin/feature-flags.service.js';
import { optionalReason, requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  FlagOrganizationRow,
  FlagOverrideRow,
  OrgFlagRow,
  PlatformFlagsRepository,
  StoredFlag,
} from './flags.repository.js';

/**
 * Platform admin · D2 Feature flags (SPEC §4 D2, §5.6, §6 0244).
 *
 * The keys are the code allowlist `OPTIONAL_MODULE_FLAGS` — a key off it is refused (400). A flag
 * locked by the server (`TMANAGE_FLAG_LOCKS`) cannot be changed here (409). The read chain itself
 * lives in `admin/feature-flags.service.ts` (`resolveFlag`), so this page's "used by N
 * organizations" and the organization's own read can never disagree.
 */

export const MAX_ALLOWLIST = 500;

export interface PlatformFlagView {
  readonly key: OptionalModuleFlag;
  /** The platform default (applies to organizations the rollout includes). */
  readonly enabled: boolean;
  readonly rollout: FlagRollout;
  readonly percentage: number | null;
  readonly allowlistOrganizationIds: readonly string[];
  /** What the code says when nothing is stored. */
  readonly codeDefault: boolean;
  /** Locked by the server: the value everywhere, or `null` when not locked. */
  readonly lockedValue: boolean | null;
  readonly forcedOn: number;
  readonly forcedOff: number;
  /** Organizations for which the flag resolves on right now. */
  readonly usedByOrganizations: number;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface PlatformFlagsView {
  readonly flags: readonly PlatformFlagView[];
  readonly organizationCount: number;
}

export interface PlatformFlagOrganizationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly allowlisted: boolean;
  /** Forced from the platform side: `on`, `off`, or `null`. */
  readonly forced: 'on' | 'off' | null;
  /** The organization's own Modules switch, or `null` when it never set one. */
  readonly organizationSetting: boolean | null;
  /** What the organization gets now. */
  readonly effective: boolean;
}

export interface PlatformFlagOrganizationsView {
  readonly key: OptionalModuleFlag;
  readonly organizations: readonly PlatformFlagOrganizationView[];
}

type Body = Readonly<Record<string, unknown>>;

function requireFlagKey(value: string): OptionalModuleFlag {
  if (!isOptionalModuleFlag(value)) {
    throw new ApiError(400, 'validation_failed', 'That is not a known feature flag.', [
      { field: 'flagKey', message: `one of ${OPTIONAL_MODULE_FLAGS.join(', ')}` },
    ]);
  }
  return value;
}

/** The layer from a PUT body. Pure; every refusal is a 400 with nothing written. */
export function parseFlagBody(body: Body): {
  layer: PlatformFlagLayer;
  overrides: Map<string, boolean | null>;
} {
  if (typeof body?.['enabled'] !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'Choose on or off.', [
      { field: 'enabled', message: 'must be a boolean' },
    ]);
  }
  const rollout = body['rollout'] ?? 'everyone';
  if (!(FLAG_ROLLOUTS as readonly unknown[]).includes(rollout)) {
    throw new ApiError(400, 'validation_failed', 'Choose who gets this flag.', [
      { field: 'rollout', message: `one of ${FLAG_ROLLOUTS.join(', ')}` },
    ]);
  }
  let percentage: number | null = null;
  if (rollout === 'percentage') {
    const raw = body['percentage'];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 100) {
      throw new ApiError(400, 'validation_failed', 'Choose a percentage from 0 to 100.', [
        { field: 'percentage', message: 'whole number 0–100' },
      ]);
    }
    percentage = raw;
  }
  let allowlist: string[] = [];
  if (rollout === 'allowlist') {
    const raw = body['allowlistOrganizationIds'];
    if (!Array.isArray(raw) || raw.length > MAX_ALLOWLIST) {
      throw new ApiError(400, 'validation_failed', 'Choose the organizations.', [
        { field: 'allowlistOrganizationIds', message: `a list of at most ${MAX_ALLOWLIST} ids` },
      ]);
    }
    allowlist = [...new Set(raw.map((id) => requireOrganizationId(id)))];
  }
  const overrides = new Map<string, boolean | null>();
  const rawOverrides = body['overrides'];
  if (rawOverrides !== undefined) {
    if (!Array.isArray(rawOverrides) || rawOverrides.length > MAX_ALLOWLIST) {
      throw new ApiError(400, 'validation_failed', 'The forced organizations are invalid.', [
        { field: 'overrides', message: 'a list of {organizationId, state}' },
      ]);
    }
    for (const item of rawOverrides as unknown[]) {
      const entry = (item ?? {}) as Record<string, unknown>;
      const id = requireOrganizationId(entry['organizationId']);
      const state = entry['state'];
      if (state !== 'on' && state !== 'off' && state !== 'none') {
        throw new ApiError(400, 'validation_failed', 'The forced organizations are invalid.', [
          { field: 'overrides', message: 'state is one of on, off, none' },
        ]);
      }
      overrides.set(id, state === 'none' ? null : state === 'on');
    }
  }
  return {
    layer: { enabled: body['enabled'], rollout: rollout as FlagRollout, percentage, allowlist },
    overrides,
  };
}

function requireOrganizationId(value: unknown): string {
  try {
    return requireId(value);
  } catch {
    throw new ApiError(400, 'validation_failed', 'One of the organizations is unknown.', [
      { field: 'organizationId', message: 'must be an organization id' },
    ]);
  }
}

const NO_LAYER: PlatformFlagLayer = {
  enabled: false,
  rollout: 'everyone',
  percentage: null,
  allowlist: [],
};

/** How each organization resolves for every flag. Pure. */
export function foldFlagUsage(
  organizations: readonly FlagOrganizationRow[],
  orgRows: readonly OrgFlagRow[],
  overrides: readonly FlagOverrideRow[],
  stored: readonly StoredFlag[],
  locks: Partial<Record<OptionalModuleFlag, boolean>>,
): Map<OptionalModuleFlag, number> {
  const flags: Partial<Record<OptionalModuleFlag, PlatformFlagLayer>> = {};
  for (const flag of stored) flags[flag.key] = flag;
  const orgSide = new Map<string, Map<string, boolean>>();
  for (const row of orgRows) {
    const map = orgSide.get(row.organizationId) ?? new Map<string, boolean>();
    map.set(row.key, row.enabled);
    orgSide.set(row.organizationId, map);
  }
  const forced = new Map<string, Partial<Record<OptionalModuleFlag, boolean>>>();
  for (const row of overrides) {
    const entry = forced.get(row.organizationId) ?? {};
    entry[row.key] = row.enabled;
    forced.set(row.organizationId, entry);
  }
  const used = new Map<OptionalModuleFlag, number>();
  for (const key of OPTIONAL_MODULE_FLAGS) used.set(key, 0);
  for (const organization of organizations) {
    const context: PlatformFlagContext = {
      organizationId: organization.id,
      flags,
      overrides: forced.get(organization.id) ?? {},
      locks,
    };
    const own = orgSide.get(organization.id);
    for (const key of OPTIONAL_MODULE_FLAGS) {
      if (resolveFlag(key, own?.get(key), context)) used.set(key, (used.get(key) ?? 0) + 1);
    }
  }
  return used;
}

export class PlatformFlagsService {
  constructor(
    private readonly repository: PlatformFlagsRepository,
    private readonly environment?: NodeJS.ProcessEnv,
  ) {}

  private get locks(): Partial<Record<OptionalModuleFlag, boolean>> {
    return parseFlagLocks((this.environment ?? process.env)['TMANAGE_FLAG_LOCKS']);
  }

  async list(context: RequestContext): Promise<PlatformFlagsView> {
    const stored = await this.repository.flags(context.correlationId);
    const overrides = await this.repository.overrides(context.correlationId);
    const { organizations, orgRows } = await this.repository.organizationsWithRows(
      context.correlationId,
    );
    const locks = this.locks;
    const used = foldFlagUsage(organizations, orgRows, overrides, stored, locks);
    const byKey = new Map(stored.map((flag) => [flag.key, flag]));
    return {
      organizationCount: organizations.length,
      flags: OPTIONAL_MODULE_FLAGS.map((key) => {
        const flag = byKey.get(key);
        const layer = flag ?? { ...NO_LAYER, enabled: DEFAULT_MODULE_ENABLED[key] };
        const forced = overrides.filter((row) => row.key === key);
        return {
          key,
          enabled: layer.enabled,
          rollout: layer.rollout,
          percentage: layer.percentage,
          allowlistOrganizationIds: layer.allowlist,
          codeDefault: DEFAULT_MODULE_ENABLED[key],
          lockedValue: locks[key] ?? null,
          forcedOn: forced.filter((row) => row.enabled).length,
          forcedOff: forced.filter((row) => !row.enabled).length,
          usedByOrganizations: used.get(key) ?? 0,
          updatedAt: flag?.updatedAt?.toISOString() ?? null,
          updatedBy: flag?.updatedBy ?? null,
        };
      }),
    };
  }

  /**
   * The organizations shown in the drawer: the search matches when `q` is given, otherwise every
   * organization the flag names (allowlist, forced) plus those that set it themselves.
   */
  async organizations(
    flagKey: string,
    query: unknown,
    context: RequestContext,
  ): Promise<PlatformFlagOrganizationsView> {
    const key = requireFlagKey(flagKey);
    const stored = (await this.repository.flags(context.correlationId)).find(
      (flag) => flag.key === key,
    );
    const overrides = (await this.repository.overrides(context.correlationId)).filter(
      (row) => row.key === key,
    );
    const { organizations: all, orgRows } = await this.repository.organizationsWithRows(
      context.correlationId,
    );
    const fragment = typeof query === 'string' ? query.trim().slice(0, 100) : '';
    let chosen: readonly FlagOrganizationRow[];
    if (fragment !== '') {
      chosen = await this.repository.searchOrganizations(fragment, context.correlationId);
    } else {
      const named = new Set<string>([
        ...(stored?.allowlist ?? []),
        ...overrides.map((row) => row.organizationId),
        ...orgRows.filter((row) => row.key === key).map((row) => row.organizationId),
      ]);
      chosen = all.filter((organization) => named.has(organization.id));
    }
    const locks = this.locks;
    const flags: Partial<Record<OptionalModuleFlag, PlatformFlagLayer>> = stored
      ? { [key]: stored }
      : {};
    return {
      key,
      organizations: chosen.map((organization) => {
        const forcedRow = overrides.find((row) => row.organizationId === organization.id);
        const ownRow = orgRows.find(
          (row) => row.organizationId === organization.id && row.key === key,
        );
        const context: PlatformFlagContext = {
          organizationId: organization.id,
          flags,
          overrides: forcedRow ? { [key]: forcedRow.enabled } : {},
          locks,
        };
        return {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          allowlisted: stored?.allowlist.includes(organization.id) ?? false,
          forced: forcedRow ? (forcedRow.enabled ? 'on' : 'off') : null,
          organizationSetting: ownRow ? ownRow.enabled : null,
          effective: resolveFlag(key, ownRow?.enabled, context),
        };
      }),
    };
  }

  /** `PUT flags/:flagKey` — the default, the rollout and the forced organizations. */
  async update(
    actor: PlatformAdminActor,
    flagKey: string,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformFlagsView> {
    const key = requireFlagKey(flagKey);
    if (this.locks[key] !== undefined) {
      throw new ApiError(409, 'conflict', 'The server locks this flag. Change it in Hostinger.');
    }
    const { layer, overrides } = parseFlagBody(body);
    const reason = optionalReason(body?.['reason']);
    const named = [...new Set([...layer.allowlist, ...overrides.keys()])];
    if (named.length > 0) {
      const found = await this.repository.organizationsById(named, context.correlationId);
      if (found.length !== named.length) {
        throw new ApiError(400, 'validation_failed', 'One of the organizations is unknown.', [
          { field: 'organizationId', message: 'must be an existing organization' },
        ]);
      }
    }
    const before = (await this.repository.flags(context.correlationId)).find(
      (flag) => flag.key === key,
    );
    await this.repository.write(
      { key, layer, overrides },
      platformAuditFor(actor, context, {
        action: 'platform.flag_updated',
        targetType: 'setting',
        targetId: null,
        targetLabel: key,
        reason,
        beforeJson: before
          ? JSON.stringify({
              enabled: before.enabled,
              rollout: before.rollout,
              percentage: before.percentage,
              allowlist: before.allowlist,
            })
          : null,
        afterJson: JSON.stringify({
          ...layer,
          overrides: Object.fromEntries(overrides),
        }),
      }),
    );
    return this.list(context);
  }
}
