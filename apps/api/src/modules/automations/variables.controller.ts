import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUTOMATION_VARIABLES_REPOSITORY } from '../../common/http/tokens.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AutomationVariableRow } from '../../common/database/schema.js';
import type { AutomationVariablesRepository } from './variables.repository.js';
import { validateVarKey, validateVarValue } from './variables.service.js';

/**
 * Automation variables (module 17, x305). An org-level, **non-secret** `(key -> value)` map a workflow
 * template may reference: list them, upsert one, remove one. Three endpoints under one org-scoped
 * resource. Secrets/credentials are explicitly out of scope (a separate Needs-Peter secret store), so
 * a key whose name looks secret-like is refused before any write.
 *
 * ## The capability
 *
 * Defining automation variables is an org-admin concern, so every route reuses `org.manage` — no
 * `automation.*` capability exists and this slice adds none. `CapabilityGuard` asks the coarse ceiling
 * question; this controller adds the authoritative org-scoped `authorize()` a suspended membership
 * fails.
 *
 * ## Org-scoped, no id leak
 *
 * A variable is addressed by its `var_key` within the acting tenant — never by a surface id — and the
 * view echoes neither the row id nor the tenant id. The tenant is read from the context, never from
 * the request, so a write lands in the acting tenant and nowhere else. `authorize()` runs before the
 * key/value validation, so an unauthorized caller is a 403 whatever they send.
 */

/** What a caller is allowed to see of one automation variable. Row id and `organizationId` are absent. */
export interface AutomationVariableView {
  readonly key: string;
  readonly value: string;
  readonly updatedBy: string;
  /** An ISO-8601 instant. */
  readonly updatedAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: AutomationVariableRow): AutomationVariableView {
  return {
    key: row.varKey,
    value: row.varValue,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface UpsertVariableBody {
  readonly value?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations/variables')
export class AutomationVariablesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AUTOMATION_VARIABLES_REPOSITORY)
    private readonly variables: AutomationVariablesRepository,
  ) {}

  /** List the organization's automation variables, key-ascending. `org.manage`; a caller without it is a 403. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly variables: readonly AutomationVariableView[] }> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'automation_variable_read_denied',
      );
    }
    const rows = await this.database.read(context, (runner) =>
      this.variables.list(runner, context),
    );
    return { variables: rows.map(toView) };
  }

  /**
   * Create or replace one variable. `org.manage` (403 otherwise, checked first); then a secret-like or
   * malformed key is a 400 with no write, and a non-string or over-long value is a 400 with no write.
   * On success one row is upserted and the current value returned.
   */
  @Put(':key')
  @RequireCapability('org.manage')
  async upsert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: UpsertVariableBody,
  ): Promise<AutomationVariableView> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'automation_variable_write_denied',
      );
    }

    const varKey = validateVarKey(key);
    const varValue = validateVarValue(body?.value);

    const row = await this.database.transaction(context, (tx) =>
      this.variables.upsert(tx, context, { varKey, varValue, updatedBy: context.userId }),
    );
    return toView(row);
  }

  /**
   * Remove one variable. `org.manage` (403 otherwise, checked first). Idempotent: a 204 whether or not
   * the key existed, so a client can DELETE freely without first reading. A malformed/secret-like key
   * is still a 400 — the same key grammar the write enforces, so no unaddressable row is implied.
   */
  @Delete(':key')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
  ): Promise<void> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'automation_variable_delete_denied',
      );
    }
    const varKey = validateVarKey(key);
    await this.database.transaction(context, (tx) => this.variables.remove(tx, context, varKey));
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayManageOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}
