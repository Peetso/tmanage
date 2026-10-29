import { Controller, Get, Inject, Optional } from '@nestjs/common';
import {
  ASSIGNABLE_INTERNAL_ROLES,
  authorize,
  capabilitiesFor,
  CLIENT_ROLES,
  MATRIX,
  MATRIX_ACTIONS,
  MATRIX_AREAS,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { Capability, MatrixAction, MatrixArea, MatrixRow, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CustomRolesRepository } from './roles.repository.js';

/**
 * platform-admin v2 · PA-01 — `GET …/admin/roles/matrix` (SPEC §3.3, feeds D7).
 *
 * Every role of the organization as a set of capabilities, plus the fixed matrix layout (areas ×
 * actions → capability) the editor draws them in. Built-in roles come from the domain ceilings
 * (TManage support is not listed: it is never assigned from inside an organization); custom roles
 * are this tenant's `custom_roles` rows, read tenant-scoped. `org.manage`, re-decided by the real
 * `authorize()` in the handler.
 */

export interface MatrixRoleView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'internal' | 'client';
  readonly builtIn: boolean;
  readonly capabilities: readonly Capability[];
}

export interface RolesMatrixView {
  readonly areas: readonly MatrixArea[];
  readonly actions: readonly MatrixAction[];
  readonly matrix: Readonly<Record<MatrixArea, MatrixRow>>;
  readonly roles: readonly MatrixRoleView[];
}

@Controller('v1/organizations/:orgSlug/admin/roles/matrix')
export class RolesMatrixController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(CustomRolesRepository)
    private readonly roles: CustomRolesRepository = new CustomRolesRepository(),
  ) {}

  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RolesMatrixView> {
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
        `roles_matrix.read:${verdict.code}`,
      );
    }
    const rows = await this.database.read(context, (runner) => this.roles.listAll(runner, context));
    const builtIn: MatrixRoleView[] = [
      ...ASSIGNABLE_INTERNAL_ROLES.map((role) => ({
        id: role,
        name: role,
        kind: 'internal' as const,
        builtIn: true,
        capabilities: capabilitiesFor(role),
      })),
      ...CLIENT_ROLES.map((role) => ({
        id: role,
        name: role,
        kind: 'client' as const,
        builtIn: true,
        capabilities: capabilitiesFor(role),
      })),
    ];
    const custom: MatrixRoleView[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: 'internal' as const,
      builtIn: false,
      capabilities: parseCustomRoleCapabilities(row.capabilitiesJson),
    }));
    return {
      areas: MATRIX_AREAS,
      actions: MATRIX_ACTIONS,
      matrix: MATRIX,
      roles: [...builtIn, ...custom],
    };
  }
}
