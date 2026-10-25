import { Body, Controller, Get, Inject, Module, Optional, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { assertCanRequireTwoStep } from '../../common/http/guards/two-step-requirement.guard.js';
import type { AuditService } from '../audit/audit.service.js';
import { isSettingOn } from '../tenancy/org-settings.allowlist.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { SecuritySettingsRepository } from './security.repository.js';
import { validateIpAllowlist } from './cidr.js';

/** Wave 9 S8 (F09): the one store the two-step requirement lives in, read by `TwoStepRequirementGuard`. */
const TWO_STEP_KEY = 'require_two_step';

/**
 * Organization security settings (Administration module 18, x176) — the read + update surface the
 * audit named absent (Admin Partial, security config). Two routes behind `org.manage`: read the
 * organization's security posture (2FA enforcement + IP allowlist, defaults if never set), and set it.
 *
 * ## One store for the two-step requirement (wave 9 S8, audit F09/F12b)
 *
 * `enforce2fa` IS the company switch `TwoStepRequirementGuard` enforces: the PUT writes
 * `org_settings.require_two_step` and the GET reads it back, so the screen can never say "On" while
 * nobody is held to it. `security_settings.enforce_2fa` is kept as a mirror only and never read. The
 * generic `PUT …/settings/require_two_step` refuses the key for everyone (`OWNER_ONLY_SETTING_KEYS`),
 * so this route is the only writer. Turning it on runs `assertCanRequireTwoStep` (no self lock-out).
 *
 * ## Owner only
 *
 * The company owner decides workspace security policy, so the PUT is the owner's alone (an
 * `org_admin` or custom role holding `org.manage` reads it and is refused the write with a 403). The
 * change and its audit row (`organization.security_settings_changed`) commit together. An absent
 * `ipAllowlist` keeps the stored list (the Organization settings screen sends `enforce2fa` alone).
 *
 * ## Two guards, and the order that matters
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The handler *also* runs the real
 * `authorize` for the same capability — the org-wide, tenant-checked decision — so the safety is a rule
 * a controller test proves directly. The write path resolves the organization tenant-scoped **before**
 * it authorizes or writes (the Known trap): a context whose organization does not exist in this tenant
 * is a 404 with no write, before the 403, before the validation 400s.
 */
export interface SecuritySettingsView {
  /** Whether members must have a second factor — the enforced `require_two_step` company switch. */
  readonly enforce2fa: boolean;
  /** The allowed source networks (IPv4/IPv6 addresses and CIDR ranges). Empty means "no restriction". */
  readonly ipAllowlist: readonly string[];
}

/** The PUT body — both fields arrive as `unknown` and are validated in the route. */
interface PutSecurityBody {
  readonly enforce2fa?: unknown;
  readonly ipAllowlist?: unknown;
}

/** The posture of an organization that has never set one: 2FA not enforced, no IP restriction. */
const DEFAULT_VIEW: SecuritySettingsView = { enforce2fa: false, ipAllowlist: [] };

@Controller('v1/organizations/:orgSlug/admin/security')
export class SecuritySettingsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AUDIT_SERVICE) private readonly audit: Pick<AuditService, 'record'>,
    @Optional()
    @Inject(SecuritySettingsRepository)
    private readonly settings: SecuritySettingsRepository = new SecuritySettingsRepository(),
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly orgSettings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  /** Read the organization's security settings — the stored posture, or the defaults if never set (200). */
  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SecuritySettingsView> {
    this.requireOrgManage(principal, context);
    return this.readView(context);
  }

  /**
   * Set the organization's security settings (200 — the stored posture after the write). The
   * organization is resolved tenant-scoped before authorize/write (Known trap: a cross-tenant context
   * is a 404, no write); a non-boolean `enforce2fa` or a malformed/over-count IP allowlist is a 400
   * with no write (nothing partially valid is ever stored).
   */
  @Put()
  @RequireCapability('org.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PutSecurityBody,
  ): Promise<SecuritySettingsView> {
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve the organization tenant-scoped, BEFORE authorize/write (Known trap): a context
      //    whose organization is not in this tenant is a 404, never a dangling upsert.
      const org = await this.settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide authorize for `org.manage` (the decorator is the coarse HTTP gate; this
      //    is the tenant-checked decision the test exercises), then owner only (F09/F12b): the
      //    company owner decides the sign-in policy.
      this.requireOrgManage(principal, context);
      if (principal.kind !== 'internal' || principal.role !== 'owner') {
        throw new ApiError(
          403,
          'forbidden',
          'Only the company owner can change this setting.',
          undefined,
          'admin_security.write:not_owner',
        );
      }

      // 3. Validate the body. `enforce2fa` must be a boolean, and the IP allowlist must be a list of
      //    valid IP/CIDR entries within the count bound — a malformed entry refuses the whole write.
      //    An absent allowlist keeps the stored one.
      if (typeof body?.enforce2fa !== 'boolean') {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'enforce2fa', message: 'A true/false value is required.' },
        ]);
      }
      const existing = await this.settings.find(tx, context);
      const allowlist = validateIpAllowlist(
        body?.ipAllowlist === undefined ? (existing?.ipAllowlistJson ?? []) : body.ipAllowlist,
      );
      if (!allowlist.ok) {
        throw new ApiError(400, 'validation_failed', 'The IP allowlist is not valid.', [
          { field: 'ipAllowlist', message: allowlist.message },
        ]);
      }

      // 4. The enforced switch. No self lock-out: only someone already enrolled may turn it on.
      const previous = isSettingOn(
        TWO_STEP_KEY,
        (await this.orgSettings.findByKey(tx, context, TWO_STEP_KEY))?.settingValue,
      );
      if (body.enforce2fa && !previous) {
        await assertCanRequireTwoStep(this.database, principal.userId, context.correlationId);
      }
      await this.orgSettings.upsert(tx, context, {
        key: TWO_STEP_KEY,
        value: String(body.enforce2fa),
        updatedBy: principal.userId,
      });

      // 5. The trusted networks (and a mirror of the switch) in the per-organization row.
      await this.settings.upsert(tx, context, {
        enforce2fa: body.enforce2fa,
        ipAllowlist: allowlist.value,
        updatedBy: principal.userId,
      });

      // 6. The audit row commits with the change, or neither does.
      await this.audit.record(tx, context, {
        action: 'organization.security_settings_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          previous_two_step: previous,
          two_step: body.enforce2fa,
          allowlist_count: allowlist.value.length,
        },
      });
    });

    return this.readView(context);
  }

  /**
   * The posture, or the defaults if the organization has never set one. `enforce2fa` is read from the
   * enforced `require_two_step` switch (F09), never from the `security_settings` mirror.
   */
  private async readView(context: TenantContext): Promise<SecuritySettingsView> {
    const { row, twoStep } = await this.database.read(context, async (runner) => ({
      row: await this.settings.find(runner, context),
      twoStep: await this.orgSettings.findByKey(runner, context, TWO_STEP_KEY),
    }));
    return {
      enforce2fa: isSettingOn(TWO_STEP_KEY, twoStep?.settingValue),
      ipAllowlist: row ? [...(row.ipAllowlistJson ?? [])] : [...DEFAULT_VIEW.ipAllowlist],
    };
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience. An
   * internal role holding `org.manage` passes; a client is refused (`org.manage` is internal-only), and
   * a cross-tenant principal by the tenant check inside `authorize`. A denial is a 403 with the
   * machine-readable code.
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
        `admin_security.write:${verdict.code}`,
      );
    }
  }
}

/**
 * x176's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * so the Administration slices stay file-disjoint. The repository is a stateless collection of a
 * tenant-scoped read and the upsert, constructed here; the controller injects it and the `@Global`
 * `TENANT_DATABASE`.
 */
@Module({})
export class AdminSecurityModule {
  static register(): DynamicModule {
    return {
      module: AdminSecurityModule,
      providers: [
        { provide: SecuritySettingsRepository, useFactory: () => new SecuritySettingsRepository() },
        { provide: OrgSettingsRepository, useFactory: () => new OrgSettingsRepository() },
      ],
      controllers: [SecuritySettingsController],
    };
  }
}
