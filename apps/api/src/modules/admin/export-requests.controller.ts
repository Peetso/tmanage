import { Body, Controller, Get, Inject, Module, Optional, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ADMIN_EXPORT_SCOPES } from '../../common/database/schema.js';
import type { AdminExportRequestRow, AdminExportScope } from '../../common/database/schema.js';
import { AdminExportRequestsRepository } from './export-requests.repository.js';

/**
 * Admin data-export requests (Administration & governance, module 18, x224) — a recorded, GDPR-style
 * request to export a studio's data, plus a status an administrator can track. Two routes behind
 * `org.manage`: list the organization's export requests, and record a new one.
 *
 * ## Record-only — no data leaves the system here
 *
 * This is a *different flow* from the audit CSV export (x197, a synchronous read of the audit trail).
 * The actual bulk export file generation and delivery — an async worker plus storage/egress — is
 * **Needs-Peter** and is not part of this slice. Recording a request produces no file and transmits
 * nothing, so the slice never touches the data-egress path: a request is created in status `pending`
 * and the later worker moves it on.
 *
 * ## Capability + tenant scope before any write
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The handler *also* runs the real
 * `authorize` for `org.manage` — the org-wide, tenant-checked decision — so the safety is a rule a
 * controller test proves directly. The write path resolves the organization tenant-scoped **before**
 * it authorizes or writes (the Known trap): a context whose organization does not exist in this tenant
 * is a 404 with no write, before the 403, before the validation 400. `scope` is validated against the
 * fixed `ADMIN_EXPORT_SCOPES` enum (400, no write) so no unknown scope is ever stored.
 */
export interface DataExportRequestView {
  readonly requests: readonly {
    readonly id: string;
    readonly scope: string;
    readonly status: string;
    readonly requestedBy: string;
    readonly requestedAt: string;
  }[];
}

/** The POST body — the scope of the requested export, arriving as `unknown`. */
interface CreateExportRequestBody {
  readonly scope?: unknown;
}

/** The org-wide resource the `org.manage` decision authorizes against. */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/export-requests')
export class AdminExportRequestsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    private readonly requests: AdminExportRequestsRepository = new AdminExportRequestsRepository(),
  ) {}

  /** List the organization's data-export requests (200). */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DataExportRequestView> {
    this.requireOrgManage(principal, context);
    return this.readAll(context);
  }

  /**
   * Record a new data-export request (200 — the full request list after the write). The organization
   * is resolved tenant-scoped before authorize/write (Known trap: a cross-tenant context is a 404, no
   * write); the scope is validated against the fixed enum (400 no write). The request is created in
   * status `pending` — no file is produced and nothing is transmitted.
   */
  @Post()
  @RequireCapability('org.manage')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateExportRequestBody,
  ): Promise<DataExportRequestView> {
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve the organization tenant-scoped, BEFORE authorize/write (Known trap): a context
      //    whose organization is not in this tenant is a 404, never a dangling insert.
      const org = await this.requests.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide authorize for `org.manage` (the decorator is the coarse HTTP gate; this
      //    is the tenant-checked decision the test exercises).
      this.requireOrgManage(principal, context);

      // 3. Validate the scope against the fixed allowlist. Anything else — a typo, an invented scope,
      //    a non-string — is a 400 with no write; no unknown scope is ever stored.
      const scope = body?.scope;
      if (typeof scope !== 'string' || !isExportScope(scope)) {
        throw new ApiError(400, 'validation_failed', 'That is not an export scope we recognise.', [
          { field: 'scope', message: 'Choose one of the available export scopes.' },
        ]);
      }

      // 4. Record the request in status `pending`. requestedAt is bound here (not the connection
      //    clock) — the admin-pool clock trap.
      await this.requests.insert(tx, context, {
        scope,
        requestedBy: principal.userId,
        requestedAt: new Date(),
      });
    });

    return this.readAll(context);
  }

  /** Every export request for the acting tenant, projected to the wire shape (tenant id never echoed). */
  private async readAll(context: TenantContext): Promise<DataExportRequestView> {
    const rows = await this.database.read(context, (runner) =>
      this.requests.listAll(runner, context),
    );
    // Newest first for the status screen, from the oldest-first repository order.
    return { requests: [...rows].reverse().map(toView) };
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience. An
   * internal role holding `org.manage` passes; anyone else is refused, and a cross-tenant principal by
   * the tenant check inside `authorize`. A denial is a 403 with the machine-readable code.
   */
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
        `admin_export_requests.manage:${verdict.code}`,
      );
    }
  }
}

/** Project a stored request row to the wire shape: identity, scope, status, who asked and when. */
function toView(row: AdminExportRequestRow): DataExportRequestView['requests'][number] {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
  };
}

/** Whether a string is one of the fixed allowlisted export scopes. */
function isExportScope(value: string): value is AdminExportScope {
  return (ADMIN_EXPORT_SCOPES as readonly string[]).includes(value);
}

/**
 * x224's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * disjoint from the other admin slices. The repository is a stateless collection of tenant-scoped
 * reads and the insert, constructed here; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class AdminExportRequestsModule {
  static register(): DynamicModule {
    return {
      module: AdminExportRequestsModule,
      providers: [
        {
          provide: AdminExportRequestsRepository,
          useFactory: () => new AdminExportRequestsRepository(),
        },
      ],
      controllers: [AdminExportRequestsController],
    };
  }
}
