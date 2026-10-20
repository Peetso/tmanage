import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Optional,
  Param,
  Put,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { OrgFeatureFlagRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FeatureFlagsRepository } from './feature-flags.repository.js';
import {
  DEFAULT_MODULE_ENABLED,
  OPTIONAL_MODULE_FLAGS,
  isOptionalModuleFlag,
  resolveFlags,
} from './feature-flags.service.js';
import type { OptionalModuleFlag } from './feature-flags.service.js';

/**
 * Per-org optional-module feature flags (Administration module 18, x278).
 *
 * `38-MODULE-MAP §3` names the optional/"later" modules an org may enable; `13-ENGINEERING-EXECUTION
 * §feature gating`; `22-SCREEN §Administration`. Two surfaces, two capabilities, both org-scoped:
 *
 *   - **Admin (`org.manage`)** — `GET …/admin/feature-flags` lists every known optional-module flag
 *     with its enabled state and who/when last changed it; `PUT …/admin/feature-flags/:key {enabled}`
 *     turns one on or off. The key must be on the fixed allowlist (a key off it is a **400** with no
 *     upsert); `enabled` must be a boolean. The set is one idempotent upsert.
 *   - **Resolved read (`work.read`)** — `GET …/feature-flags` returns the resolved flag map for the
 *     caller's own org: every known key with its resolved state, an absent or unknown key resolving
 *     to that module's default (on for the live modules, off for the copilot). No id is ever echoed,
 *     so nothing about another studio can leak.
 *
 * ## The capability is the boundary, and it is re-asserted where the write is
 *
 * The write route sits behind `@RequireCapability('org.manage')` (the coarse `CapabilityGuard` gate)
 * **and** re-runs the real org-wide `authorize` inside the handler before any validation or write —
 * the same defence-in-depth `role-edit.controller.ts` uses — so a caller without `org.manage` is a
 * **403** with no upsert regardless of the body. The resolve is scoped to `context.organizationId`;
 * neither route takes any path or query that could name another org.
 */

/** One flag's admin projection: its key, enabled state, and who/when last changed it (no row id). */
export interface FeatureFlagAdminView {
  readonly key: OptionalModuleFlag;
  readonly enabled: boolean;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}

/** The admin list: every known optional-module flag, in the fixed allowlist order. */
export interface FeatureFlagsAdminView {
  readonly flags: readonly FeatureFlagAdminView[];
}

/** The resolved map the current-org read-side reads: every known key with its resolved state. */
export interface FeatureFlagsResolvedView {
  readonly flags: Record<OptionalModuleFlag, boolean>;
}

/** The PUT body: whether to enable the flag. */
interface SetFlagBody {
  readonly enabled?: unknown;
}

/** The org-wide resource the `org.manage` decision authorizes against (the roles/role-edit shape). */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/feature-flags')
export class AdminFeatureFlagsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(FeatureFlagsRepository)
    private readonly flags: FeatureFlagsRepository = new FeatureFlagsRepository(),
  ) {}

  /** List every known optional-module flag with its enabled state and last-change attribution. */
  @Get()
  @RequireCapability('org.manage')
  async list(@Ctx() context: TenantContext): Promise<FeatureFlagsAdminView> {
    const rows = await this.database.read(context, (runner) => this.flags.list(runner, context));
    return { flags: foldAdmin(rows) };
  }

  /**
   * Enable or disable one optional-module flag (200 — the flag's new state). The real `org.manage`
   * authorize runs first (403 no upsert); the key is checked against the fixed allowlist (400 no
   * upsert); `enabled` is validated as a boolean (400); then a single upsert records the state and
   * the acting membership.
   */
  @Put(':key')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: SetFlagBody,
  ): Promise<FeatureFlagAdminView> {
    // 1. The real org-wide `org.manage` decision, before any validation or write.
    this.requireOrgManage(principal, context);

    // 2. The key must be on the fixed allowlist — off it is a 400 with no upsert.
    if (!isOptionalModuleFlag(key)) {
      throw new ApiError(400, 'validation_failed', 'That is not a known optional-module flag.', [
        { field: 'key', message: 'The feature flag key is not recognised.' },
      ]);
    }

    // 3. `enabled` must be a boolean.
    if (typeof body?.enabled !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'A flag needs an enabled state.', [
        { field: 'enabled', message: 'Provide enabled as true or false.' },
      ]);
    }
    const enabled = body.enabled;

    // 4. One idempotent upsert, recording the acting membership as the changer.
    const row = await this.database.transaction(context, (tx) =>
      this.flags.upsert(tx, context, { flagKey: key, enabled, updatedBy: principal.membershipId }),
    );
    return toAdminView(key, row);
  }

  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: orgWideResource(context),
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `feature_flags.manage:${verdict.code}`,
      );
    }
  }
}

@Controller('v1/organizations/:orgSlug/feature-flags')
export class FeatureFlagsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(FeatureFlagsRepository)
    private readonly flags: FeatureFlagsRepository = new FeatureFlagsRepository(),
  ) {}

  /** The resolved flag map for the caller's own org — every known key with its resolved state. */
  @Get()
  @RequireCapability('work.read')
  async resolved(@Ctx() context: TenantContext): Promise<FeatureFlagsResolvedView> {
    const rows = await this.database.read(context, (runner) => this.flags.list(runner, context));
    return { flags: resolveFlags(rows) };
  }
}

/** Fold stored rows into an admin projection over every known flag, in the fixed allowlist order. */
function foldAdmin(rows: readonly OrgFeatureFlagRow[]): FeatureFlagAdminView[] {
  const byKey = new Map<string, OrgFeatureFlagRow>();
  for (const row of rows) byKey.set(row.flagKey, row);
  return OPTIONAL_MODULE_FLAGS.map((key) => {
    const row = byKey.get(key);
    return row
      ? toAdminView(key, row)
      : { key, enabled: DEFAULT_MODULE_ENABLED[key], updatedBy: null, updatedAt: null };
  });
}

/** Project one stored flag row (or the just-upserted row) to the admin wire shape. */
function toAdminView(key: OptionalModuleFlag, row: OrgFeatureFlagRow): FeatureFlagAdminView {
  return {
    key,
    enabled: row.enabled,
    updatedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * x278's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from the other administration slices. Both controllers share one repository.
 */
@Module({})
export class FeatureFlagsModule {
  static register(): DynamicModule {
    return {
      module: FeatureFlagsModule,
      providers: [
        { provide: FeatureFlagsRepository, useFactory: () => new FeatureFlagsRepository() },
      ],
      controllers: [AdminFeatureFlagsController, FeatureFlagsController],
    };
  }
}
