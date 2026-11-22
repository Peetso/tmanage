import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { AgentKeysService } from '../personal-access-tokens/agent-keys.js';
import { InviteeAccountsRepository } from '../tenancy/invitee-accounts.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { AI_EMPLOYEES_SERVICE, AiEmployeesController } from './ai-employees.controller.js';
import { AiEmployeesRepository } from './ai-employees.repository.js';
import { AiEmployeesService, aiEmployeesEnabled } from './ai-employees.service.js';

/**
 * 60-03 (plan 60 v2) — AI employees, part of the Tenancy & People context (VIEWS §4). Owns
 * `ai_employees` and `ai_excluded_projects`; writes the membership through tenancy's
 * `MembershipsRepository` (the same context) and the credential-less user through the invitee
 * account writer.
 *
 * Behind the server switch `TMANAGE_AI_EMPLOYEES=on`, off by default: while off every route is
 * the calm 404 `not_found` (`feature.ai_employees_off`). The routes are NEVER in the AI action
 * registry, so they are absent from the MCP catalog and `/openapi/ai.json` in both states.
 */
@Module({})
export class AiEmployeesModule {
  static register(): DynamicModule {
    return {
      module: AiEmployeesModule,
      providers: [
        {
          provide: AI_EMPLOYEES_SERVICE,
          inject: [TENANT_DATABASE, AUDIT_SERVICE],
          useFactory: (database: TenantDatabase, audit: AuditService) =>
            new AiEmployeesService({
              database,
              audit,
              repository: new AiEmployeesRepository(),
              memberships: new MembershipsRepository(),
              accounts: new InviteeAccountsRepository(),
              agentKeys: new AgentKeysService(),
              enabled: aiEmployeesEnabled(process.env),
            }),
        },
      ],
      controllers: [AiEmployeesController],
    };
  }
}
