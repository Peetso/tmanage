import { Body, Controller, Inject, Module, Optional, Param, Patch, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize, CAPABILITIES, mayGrantCapability } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { RoleEditRepository } from './role-edit.repository.js';
import { requireRoleAssigner } from '../tenancy/role-grant-ceiling.js';

/**
 * Custom role clone + edit (Administration module 18, x195) — the lifecycle the audit named absent after
 * x173 gave the roles surface create + list only. Two routes behind `org.manage`, both operating on an
 * **existing** tenant role addressed by `:id`:
 *
 *   - **POST `…/admin/roles/:id/clone`** — duplicate a role under a new name (its capability subset is
 *     copied verbatim, then re-checked against the caller).
 *   - **PATCH `…/admin/roles/:id`** — update a role's name and capability subset in place.
 *
 * ## The same escalation boundary as x173, now on the id path
 *
 * A custom role stores a **subset of the fixed `CAPABILITIES` allowlist** (`12-PERMISSION-MATRIX` §2) and
 * may never grant beyond its author. Editing and cloning are exactly where that boundary could be
 * widened, so both write paths re-assert it — no `capabilities.ts` edit is involved:
 *
 * 1. **Allowlist.** Every capability written (the new subset on edit, the copied subset on clone) must be
 *    a string in `CAPABILITIES`. Anything else is a 400 with no write. A clone whose stored source
 *    somehow carried an unrecognised string is refused rather than propagated.
 * 2. **Privilege-escalation guard.** Every capability written must be one the **caller can actually
 *    exercise org-wide right now**, decided by the real `authorize` against an org-wide internal
 *    resource. A capability the caller cannot exercise is a 403 with no write — so an edit can never
 *    widen a role past the person editing it, and **a cloned role can never carry caps beyond the caller**
 *    even if the source role (defined by someone more privileged) held them.
 *
 * ## Resolve the id tenant-scoped BEFORE authorize or write (the Known trap)
 *
 * `@RequireCapability('org.manage')` is the coarse gate `CapabilityGuard` reads before any handler runs.
 * The handler *also* resolves the addressed role tenant-scoped **first** — a role belonging to another
 * tenant, or no role at all, is a 404 with no write, decided before the real `org.manage` authorize, the
 * validation 400s, the escalation 403 and the duplicate-name 409. A cross-tenant id is therefore
 * indistinguishable from an unknown one, and never leaks its existence through a 403.
 */

/** The single role affected by a clone or an edit — the wire projection (tenant id never echoed). */
export interface RoleEditView {
  readonly role: {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly string[];
    readonly createdAt: string;
  };
}

/** The clone body — the new role's name (the capability subset is copied from the source). */
interface CloneRoleBody {
  readonly name?: unknown;
}

/** The edit body — a new name and a new capability subset, both arriving as `unknown`. */
interface EditRoleBody {
  readonly name?: unknown;
  readonly capabilities?: unknown;
}

/** The org-wide resource the escalation guard and the `org.manage` decision authorize against. */
function orgWideResource(context: TenantContext) {
  return {
    organizationId: context.organizationId,
    projectId: null,
    audience: 'internal' as const,
    lifecycle: 'active' as const,
  };
}

@Controller('v1/organizations/:orgSlug/admin/roles')
export class RoleEditController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(RoleEditRepository)
    private readonly roles: RoleEditRepository = new RoleEditRepository(),
    @Optional() @Inject(AUDIT_SERVICE) private readonly audit?: AuditService,
  ) {}

  /**
   * Clone a role under a new name (200 — the new role). The addressed role is resolved tenant-scoped
   * first (unknown/cross-tenant id → 404 no write); the caller's `org.manage` is authorized for real;
   * the new name is validated (400 no write); the copied capability subset is re-checked against the
   * allowlist (400) and the caller (403 no write) so a clone can never widen access; a duplicate name is
   * a 409 with no write.
   */
  @Post(':id/clone')
  @RequireCapability('org.manage')
  async clone(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: CloneRoleBody,
  ): Promise<RoleEditView> {
    // Wave 10 R5 (F30): editing or cloning a role re-roles every holder, so it is an "Assign roles"
    // act (`12-PERMISSION-MATRIX` §2: owner and org_admin only), refused before any read or write —
    // the same rule the single and bulk member-role routes apply. A delegated `org.manage` custom
    // role therefore cannot rewrite the roles other people hold.
    requireRoleAssigner(principal, 'custom_roles.clone');
    const created = await this.database.transaction(context, async (tx) => {
      // 1. Resolve the addressed role tenant-scoped, BEFORE authorize/write (Known trap).
      const source = await this.roles.findById(tx, context, id);
      if (!source) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide `org.manage` decision (the decorator is the coarse HTTP gate).
      this.requireOrgManage(principal, context);

      // 3. Validate the new name.
      const name = validateName(body?.name);

      // 4. Re-check the copied capability subset against the allowlist AND the caller — a clone may never
      //    carry a capability off the allowlist or one the caller cannot itself exercise.
      const capabilities = parseCapabilities(source.capabilitiesJson);
      assertAllAllowlisted(capabilities);
      assertCallerHolds(principal, context, capabilities);

      // 5. Duplicate name → 409, no write.
      const existing = await this.roles.findByName(tx, context, name);
      if (existing) throw new ApiError(409, 'conflict', 'A role with that name already exists.');

      // 6. Insert the copy, and record it (ADM-11) with the role it was copied from.
      const copy = await this.roles.insert(tx, context, {
        name,
        capabilities,
        createdBy: principal.userId,
      });
      await this.audit?.record(tx, context, {
        action: 'custom_role.created',
        objectId: copy.id,
        result: 'allowed',
        metadata: { capability_count: capabilities.length, cloned_from: source.id },
      });
      return copy;
    });

    return { role: toView(created) };
  }

  /**
   * Edit a role's name and capability subset in place (200 — the updated role). Same ordering as clone:
   * resolve the id tenant-scoped first (404 no write), then the real `org.manage` authorize, then
   * validate the name (400) and the new subset against the allowlist (400) and the caller (403), then a
   * duplicate-name check that ignores the role itself (409). Only then is the row updated.
   */
  @Patch(':id')
  @RequireCapability('org.manage')
  async edit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: EditRoleBody,
  ): Promise<RoleEditView> {
    // Wave 10 R5 (F30): an edit changes what every holder of the role can do — owner / org_admin only,
    // before any read or write (see clone).
    requireRoleAssigner(principal, 'custom_roles.edit');
    const updated = await this.database.transaction(context, async (tx) => {
      // 1. Resolve the addressed role tenant-scoped, BEFORE authorize/write (Known trap).
      const target = await this.roles.findById(tx, context, id);
      if (!target) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The real org-wide `org.manage` decision.
      this.requireOrgManage(principal, context);

      // 3. Validate the new name.
      const name = validateName(body?.name);

      // 4. Validate the new capability subset: a non-empty array of allowlisted strings, every one of
      //    which the caller can exercise org-wide (400 off-allowlist, 403 escalation — no write).
      const requested = body?.capabilities;
      if (!Array.isArray(requested) || requested.length === 0) {
        throw new ApiError(400, 'validation_failed', 'Choose at least one capability.', [
          { field: 'capabilities', message: 'Select one or more capabilities for the role.' },
        ]);
      }
      const capabilities = dedupe(requested);
      assertAllAllowlisted(capabilities);
      assertCallerHolds(principal, context, capabilities as Capability[]);

      // 5. Duplicate name → 409, ignoring the role being edited (a rename to its own name is fine).
      const clash = await this.roles.findByName(tx, context, name);
      if (clash && clash.id !== target.id) {
        throw new ApiError(409, 'conflict', 'A role with that name already exists.');
      }

      // 6. Update the row, and record it (ADM-11): every holder of the role gains or loses with it.
      const changed = await this.roles.update(tx, context, {
        id: target.id,
        name,
        capabilities: capabilities as string[],
      });
      await this.audit?.record(tx, context, {
        action: 'custom_role.updated',
        objectId: changed.id,
        result: 'allowed',
        metadata: { capability_count: capabilities.length },
      });
      return changed;
    });

    return { role: toView(updated) };
  }

  /**
   * The real `org.manage` decision — org-wide (`projectId: null`, internal audience), the shape the
   * roles surface uses for the same capability. A denial is a 403 with the machine-readable code.
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

/** Validate a role name: a trimmed, non-empty, bounded string. Throws 400 with no write otherwise. */
function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
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
  return name;
}

/** Every requested capability must be an allowlisted capability string, or it is a 400 with no write. */
function assertAllAllowlisted(values: readonly unknown[]): asserts values is Capability[] {
  for (const cap of values) {
    if (typeof cap !== 'string' || !isCapability(cap)) {
      throw new ApiError(400, 'validation_failed', 'That is not a capability we recognise.', [
        { field: 'capabilities', message: 'One or more capabilities are not recognised.' },
      ]);
    }
  }
}

/**
 * The privilege-escalation guard: every capability must be one the caller can exercise org-wide right
 * now (the real evaluator), so neither a clone nor an edit can widen a role past its author. A capability
 * the caller cannot exercise is a 403 with no write. The one exemption is an active internal owner,
 * who may grant any capability (A1); an org_admin and every other role keep the SEC-011 refusal.
 */
function assertCallerHolds(
  principal: Principal,
  context: TenantContext,
  capabilities: readonly Capability[],
): void {
  for (const cap of capabilities) {
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
}

/** Project a stored role row to the wire shape: identity, name, capability subset, when it was created. */
function toView(row: CustomRoleRow): RoleEditView['role'] {
  return {
    id: row.id,
    name: row.name,
    capabilities: parseCapabilities(row.capabilitiesJson),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Parse the stored JSON capability array defensively, keeping only allowlisted strings. */
function parseCapabilities(json: string): Capability[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is Capability => typeof c === 'string' && isCapability(c));
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
 * x195's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from x173's roles surface. The repository is a stateless collection of tenant-scoped
 * queries; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class RoleEditModule {
  static register(): DynamicModule {
    return {
      module: RoleEditModule,
      providers: [{ provide: RoleEditRepository, useFactory: () => new RoleEditRepository() }],
      controllers: [RoleEditController],
    };
  }
}
