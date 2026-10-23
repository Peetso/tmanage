import { Body, Controller, Get, Inject, Module, Optional, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize, CAPABILITIES, mayGrantCapability } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { CustomRolesRepository } from './roles.repository.js';

/**
 * Custom roles (Administration module 18, x173) — the roles surface the audit (rank #9) named absent.
 * Two routes behind `org.manage`: list the organization's custom roles, and define a new one (a name
 * plus a subset of the fixed capability allowlist).
 *
 * ## No new capability, and no escalation — the substance of the slice
 *
 * A custom role stores a **subset of the fixed `CAPABILITIES` allowlist** (`12-PERMISSION-MATRIX` §2).
 * It never adds a capability, and it may never grant beyond its author. Two guards make that concrete
 * on the write path, and no `capabilities.ts` edit is involved:
 *
 * 1. **Allowlist.** Every requested capability must be a string in `CAPABILITIES`. Anything else — a
 *    typo, an invented capability, a non-string — is a 400 with no write. No arbitrary capability can
 *    ever be stored.
 * 2. **Privilege-escalation guard.** Every requested capability must be one the **caller can actually
 *    exercise org-wide right now**, decided by the real `authorize` against an org-wide internal
 *    resource. A capability the caller cannot exercise (e.g. a reviewer-gated one they hold only per
 *    object, or one outside their role ceiling) is a 403 with no write — a role can never widen access
 *    past the person defining it.
 *
 * ## Two guards, and the order that matters
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads: a caller whose role
 * does not hold `org.manage` is refused 403 before any handler runs. The handler *also* runs the real
 * `authorize` for `org.manage` — the org-wide, tenant-checked decision — so the safety is a rule a
 * controller test proves directly. The write path resolves the organization tenant-scoped **before** it
 * authorizes or writes (the Known trap): a context whose organization does not exist in this tenant is a
 * 404 with no write, before the 403, before the validation 400s, before the duplicate-name 409.
 */
export interface CustomRoleView {
  readonly roles: readonly {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly string[];
    readonly createdAt: string;
  }[];
}

/** The POST body — a role name and its requested capability subset, both arriving as `unknown`. */
interface CreateRoleBody {
  readonly name?: unknown;
  readonly capabilities?: unknown;
}

/** The org-wide resource the escalation guard authorizes each requested capability against. */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/roles')
export class CustomRolesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(CustomRolesRepository)
    private readonly roles: CustomRolesRepository = new CustomRolesRepository(),
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  /** List the organization's custom roles (200). */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CustomRoleView> {
    this.requireOrgManage(principal, context);
    return this.readAll(context);
  }

  /**
   * Define a new custom role (200 — the full role list after the write). The organization is resolved
   * tenant-scoped before authorize/write (Known trap: a cross-tenant context is a 404, no write); the
   * name and capability list are validated (400 no write), every capability must be one the caller can
   * exercise (403 no write), and a duplicate name is a 409 with no write.
   */
  @Post()
  @RequireCapability('org.manage')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateRoleBody,
  ): Promise<CustomRoleView> {
    await this.database.transaction(context, async (tx) => {
      // 1. Resolve the organization tenant-scoped, BEFORE authorize/write (Known trap): a context whose
      //    organization is not in this tenant is a 404, never a dangling insert.
      const org = await this.roles.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide authorize for `org.manage` (the decorator is the coarse HTTP gate; this is
      //    the tenant-checked decision the test exercises).
      this.requireOrgManage(principal, context);

      // 3. Validate the name: a non-empty, reasonably-bounded string.
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name.length === 0) {
        throw new ApiError(400, 'validation_failed', 'A role name is required.', [
          { field: 'name', message: 'Enter a name for the role.' },
        ]);
      }
      if (name.length > 128) {
        throw new ApiError(400, 'validation_failed', 'That role name is too long.', [
          { field: 'name', message: 'Keep the name to 128 characters or fewer.' },
        ]);
      }

      // 4. Validate the capability list: a non-empty array of allowlisted capability strings. A
      //    non-array, an empty list, a non-string element, or any string off the `CAPABILITIES`
      //    allowlist is a 400 with no write — no arbitrary capability is ever stored.
      const requested = body?.capabilities;
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new ApiError(400, 'validation_failed', 'Choose at least one capability.', [
          { field: 'capabilities', message: 'Select one or more capabilities for the role.' },
        ]);
      }
      const capabilities = dedupe(requested);
      for (const cap of capabilities) {
        if (typeof cap !== 'string' || !isCapability(cap)) {
          throw new ApiError(400, 'validation_failed', 'That is not a capability we recognise.', [
            { field: 'capabilities', message: 'One or more capabilities are not recognised.' },
          ]);
        }
      }

      // 5. Privilege-escalation guard: every requested capability must be one the CALLER can actually
      //    exercise org-wide right now (the real evaluator), so a role can never widen access past its
      //    author. A capability the caller cannot exercise is a 403 with no write — the owner
      //    included, so no one can mint a reviewer-gated capability org-wide (SEC-011).
      for (const cap of capabilities as Capability[]) {
        const verdict = mayGrantCapability(principal, cap, context.organizationId);
        if (!verdict.allowed) {
          throw new ApiError(
            403,
            'forbidden',
            'You can only grant capabilities you hold yourself.',
            undefined,
            `custom_roles.escalation:${verdict.code}`,
          );
        }
      }

      // 6. Duplicate name → 409, no write. The unique key makes the conflict authoritative; this read
      //    turns it into the documented status before the insert.
      const existing = await this.roles.findByName(tx, context, name);
      if (existing) {
        throw new ApiError(409, 'conflict', 'A role with that name already exists.');
      }

      // 7. Insert the validated role, and record it (ADM-11): a new set of capabilities is a
      //    permission change. The name is the admin's own label, never personal data.
      const roleId = await this.roles.insert(tx, context, {
        name,
        capabilities: capabilities as string[],
        createdBy: principal.userId,
      });
      await this.audit?.record(tx, context, {
        action: 'custom_role.created',
        objectId: roleId,
        result: 'allowed',
        metadata: { capability_count: capabilities.length },
      });
    });

    return this.readAll(context);
  }

  /** Every custom role for the acting tenant, projected to the wire shape (tenant id never echoed). */
  private async readAll(context: TenantContext): Promise<CustomRoleView> {
    const rows = await this.database.read(context, (runner) => this.roles.listAll(runner, context));
    return { roles: rows.map(toView) };
  }

  /**
   * The real `org.manage` decision — org-wide, so `projectId: null` and an internal audience (the shape
   * `OrgSettingsController` uses for the same capability). An internal role holding `org.manage` passes;
   * anyone else is refused, and a cross-tenant principal by the tenant check inside `authorize`. A
   * denial is a 403 with the machine-readable code.
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
        `custom_roles.manage:${verdict.code}`,
      );
    }
  }
}

/** Project a stored role row to the wire shape: identity, name, capability subset, when it was created. */
function toView(row: CustomRoleRow): CustomRoleView['roles'][number] {
  return {
    id: row.id,
    name: row.name,
    capabilities: parseCapabilities(row.capabilitiesJson),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Parse the stored JSON capability array defensively, keeping only allowlisted strings. */
function parseCapabilities(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === 'string' && isCapability(c));
  } catch {
    return [];
  }
}

/** Whether a string is one of the fixed allowlisted capabilities. */
function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Drop duplicate entries from the requested list, preserving order. */
function dedupe(values: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * x173's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * disjoint from the tenancy slices. The repository is a stateless collection of tenant-scoped reads and
 * the insert, constructed here; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class CustomRolesModule {
  static register(): DynamicModule {
    return {
      module: CustomRolesModule,
      providers: [
        { provide: CustomRolesRepository, useFactory: () => new CustomRolesRepository() },
      ],
      controllers: [CustomRolesController],
    };
  }
}
