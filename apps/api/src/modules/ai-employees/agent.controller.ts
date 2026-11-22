import { Controller, Get, Inject } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { AgentWhoamiService, AgentWhoamiView } from './agent-whoami.js';

/**
 * 60-06 (plan 60 v2 §4.4) — the agent contract's REST mirror, `/v1/organizations/:orgSlug/agent`.
 * Only an AI employee's agent key reaches it (the tool wall in `SessionAuthGuard`), and only after
 * the agent gate in `TenantContextGuard` stamped the context. Every route is a NEVER entry
 * (`agent_contract`). `GET me` is `agent_whoami`.
 */

export const AGENT_WHOAMI_SERVICE = Symbol.for('tmanage.AgentWhoamiService');

@Controller('v1/organizations/:orgSlug/agent')
export class AgentController {
  constructor(@Inject(AGENT_WHOAMI_SERVICE) private readonly service: AgentWhoamiService) {}

  @Get('me')
  @RequireCapability('work.read')
  whoami(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AgentWhoamiView> {
    return this.service.whoami(context, principal);
  }
}
