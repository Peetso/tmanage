import { Body, Controller, Get, Inject, Module, Optional, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SecuritySettingsRepository } from './security.repository.js';
import { validateIpAllowlist } from './cidr.js';

/**
 * Organization security settings (Administration module 18, x176) — the read + update surface the
 * audit named absent (Admin Partial, security config). Two routes behind `org.manage`: read the
 * organization's security posture (2FA enforcement + IP allowlist, defaults if never set), and set it.
 *
 * ## Config surface only — enforcement is a later slice
 *
 * This slice **stores** the posture; it does not act on it. Nothing here refuses a login by IP or
 * requires a second factor — wiring that into the identity/auth path is a follow-up (NEXT-SCOPES-13),
 * deliberately separate so this config-only phase cannot lock an administrator out of their own org
 * while they are still setting the values. What this slice guarantees is that the stored config is
 * *well-formed*: every allowlist entry is a valid IP/CIDR, or the write is refused whole.
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
  /** Whether members must have a second factor enrolled. Enforcement is a later slice; this is the stored intent. */
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
    @Optional()
    private readonly settings: SecuritySettingsRepository = new SecuritySettingsRepository(),
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
      //    is the tenant-checked decision the test exercises).
      this.requireOrgManage(principal, context);

      // 3. Validate the body. `enforce2fa` must be a boolean, and the IP allowlist must be a list of
      //    valid IP/CIDR entries within the count bound — a malformed entry refuses the whole write.
      if (typeof body?.enforce2fa !== 'boolean') {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'enforce2fa', message: 'A true/false value is required.' },
        ]);
      }
      const allowlist = validateIpAllowlist(body?.ipAllowlist ?? []);
      if (!allowlist.ok) {
        throw new ApiError(400, 'validation_failed', 'The IP allowlist is not valid.', [
          { field: 'ipAllowlist', message: allowlist.message },
        ]);
      }

      // 4. Upsert the single per-organization row: a first write inserts, a re-save overwrites in place.
      await this.settings.upsert(tx, context, {
        enforce2fa: body.enforce2fa,
        ipAllowlist: allowlist.value,
        updatedBy: principal.userId,
      });
    });

    return this.readView(context);
  }

  /** The stored posture, or the defaults if the organization has never set one. */
  private async readView(context: TenantContext): Promise<SecuritySettingsView> {
    const row = await this.database.read(context, (runner) => this.settings.find(runner, context));
    if (!row) return DEFAULT_VIEW;
    return {
      enforce2fa: row.enforce2fa,
      ipAllowlist: [...(row.ipAllowlistJson ?? [])],
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
      ],
      controllers: [SecuritySettingsController],
    };
  }
}
