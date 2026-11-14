import { Body, Controller, Get, Inject, Module, Optional, Param, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  DEFAULT_LOCALE_SETTING_KEY,
  ORG_SETTING_KEYS,
  defaultFor,
  isOrgSettingKey,
  isOwnerOnlySettingKey,
  validateDefaultLocale,
  validateValue,
} from './org-settings.allowlist.js';
import { OrgSettingsRepository } from './org-settings.repository.js';
import { ClientFilePolicyController } from './client-file-policy.controller.js';
import { DownloadScanPolicyController } from './download-scan-policy.controller.js';

/**
 * Organization settings / policy (Administration module 18, x153) — the read + update surface the
 * audit named absent. Two routes behind `org.manage`: read the organization's settings (every
 * allowlisted key, its stored value or its default), and set one key.
 *
 * ## The allowlist is the substance
 *
 * `org-settings.allowlist.ts` is the single source of which keys exist, their defaults and their
 * per-key validators. A key outside it is a 400 with no write, and a value the key's validator
 * rejects is a 400 with no write — so no arbitrary key can ever be written. The role/capability
 * editor (ADM-03) stays out (blocked), as do security-policy escalations (NEXT-SCOPES-13).
 *
 * ## Two guards, and the order that matters
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The handler *also* runs the real
 * `authorize` for the same capability — the org-wide, tenant-checked decision — so the safety is a
 * rule a controller test proves directly. The write path resolves the organization tenant-scoped
 * **before** it authorizes or writes (the Known trap): a context whose organization does not exist in
 * this tenant is a 404 with no write, before the 403, before the allowlist 400s.
 */
export interface OrgSettingsView {
  readonly settings: readonly {
    readonly key: string;
    readonly value: string;
  }[];
}

/** The PUT body — `value` arrives as `unknown` and is coerced/validated in the route. */
interface PutSettingBody {
  readonly value?: unknown;
}

@Controller('v1/organizations/:orgSlug/settings')
export class OrgSettingsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  /** Read the organization's settings — every allowlisted key with its stored value or its default (200). */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgSettingsView> {
    this.requireOrgManage(principal, context);
    return this.readAll(context);
  }

  /**
   * Set one allowlisted key (200 — the full settings after the write). The organization is resolved
   * tenant-scoped before authorize/write (Known trap: a cross-tenant context is a 404, no write); an
   * off-allowlist key or a value the validator rejects is a 400 with no write.
   */
  @Put(':key')
  @RequireCapability('org.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: PutSettingBody,
  ): Promise<OrgSettingsView> {
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve the organization tenant-scoped, BEFORE authorize/write (Known trap): a context
      //    whose organization is not in this tenant is a 404, never a dangling upsert.
      const org = await this.settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide authorize for `org.manage` (the decorator is the coarse HTTP gate; this
      //    is the tenant-checked decision the test exercises).
      this.requireOrgManage(principal, context);

      // R12 R2: the workspace's default language lives on `organizations.default_locale`.
      if (key === DEFAULT_LOCALE_SETTING_KEY) {
        const locale = validateDefaultLocale(coerceValue(body?.value) ?? '');
        if (!locale.ok) {
          throw new ApiError(
            400,
            'validation_failed',
            'That value is not allowed for this setting.',
            [{ field: 'value', message: locale.message }],
          );
        }
        await this.settings.updateDefaultLocale(tx, context, locale.value);
        return;
      }

      // 3. The allowlist is the boundary: an off-list key or a value the validator rejects is a 400
      //    with no write. No arbitrary key is ever stored.
      if (!isOrgSettingKey(key)) {
        throw new ApiError(400, 'validation_failed', 'That is not a setting we recognise.', [
          { field: 'key', message: 'Unknown setting.' },
        ]);
      }
      // B3: an owner-only key has its own owner-only, audited route; this generic one never
      // writes it, so an org_admin holding `org.manage` cannot reach it from here. Wave 9 S8:
      // `require_two_step` is one of them (F12b), so an AI grant or a script driving this generic
      // route cannot switch the company's two-step requirement off.
      if (isOwnerOnlySettingKey(key)) {
        throw new ApiError(
          403,
          'forbidden',
          'Only the company owner can change this setting.',
          undefined,
          `org_settings.write:owner_only:${key}`,
        );
      }
      const raw = coerceValue(body?.value);
      if (raw === undefined) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'value', message: 'A value is required.' },
        ]);
      }
      const validation = validateValue(key, raw);
      if (!validation.ok) {
        throw new ApiError(
          400,
          'validation_failed',
          'That value is not allowed for this setting.',
          [{ field: 'value', message: validation.message }],
        );
      }

      // 4. Upsert on (organization_id, setting_key): a first write inserts, a re-set overwrites.
      await this.settings.upsert(tx, context, {
        key,
        value: validation.value,
        updatedBy: principal.userId,
      });
    });

    return this.readAll(context);
  }

  /** Every allowlisted key with its stored value or its default, in the allowlist's fixed order. */
  private async readAll(context: TenantContext): Promise<OrgSettingsView> {
    const [rows, defaultLocale] = await this.database.read(
      context,
      async (runner) =>
        [
          await this.settings.listAll(runner, context),
          await this.settings.readDefaultLocale(runner, context),
        ] as const,
    );
    const stored = new Map(rows.map((row) => [row.settingKey, row.settingValue]));
    return {
      settings: [
        ...ORG_SETTING_KEYS.map((key) => ({
          key,
          value: stored.get(key) ?? defaultFor(key),
        })),
        // R12 R2: the organization column, after the allowlisted rows.
        { key: DEFAULT_LOCALE_SETTING_KEY, value: defaultLocale ?? 'en' },
      ],
    };
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience (the
   * shape `ClientsService` uses for the same capability). An internal role holding `org.manage`
   * passes; a client is refused (`org.manage` is internal-only), and a cross-tenant principal by the
   * tenant check inside `authorize`. A denial is a 403 with the machine-readable code.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `org_settings.write:${verdict.code}`,
      );
    }
  }
}

/**
 * Coerce a JSON body value to the canonical string the validators parse. A string is taken as-is; a
 * number or boolean is stringified (so `true`/`42` sent as JSON literals are accepted); anything else
 * (object, array, null, undefined) is refused as absent.
 */
function coerceValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/**
 * x153's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into `TenancyModule`, so the tenancy slices stay file-disjoint. The repository
 * is a stateless collection of tenant-scoped reads and the upsert, constructed here; the controller
 * injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class OrgSettingsModule {
  static register(): DynamicModule {
    return {
      module: OrgSettingsModule,
      providers: [
        { provide: OrgSettingsRepository, useFactory: () => new OrgSettingsRepository() },
      ],
      // B3: the owner-only "downloads before a virus scan" route, on the same repository; FIX6:
      // the owner-only "files clients can receive" route beside it.
      controllers: [
        OrgSettingsController,
        DownloadScanPolicyController,
        ClientFilePolicyController,
      ],
    };
  }
}
