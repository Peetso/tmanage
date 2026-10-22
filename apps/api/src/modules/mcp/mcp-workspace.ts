import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../tenancy/membership-resolver.repository.js';
import { OrganizationsRepository } from '../tenancy/organizations.repository.js';

/**
 * **The token's own workspace (finding F2).** The tools act in exactly one organization — the one
 * the token or grant is bound to — so its slug and the member's capabilities are read from that
 * binding here, server side. Nothing calls the organization directory (`GET /v1/organizations/`,
 * a NEVER route) and the model never names an organization.
 */
export interface McpWorkspace {
  readonly orgSlug: string;
  /** The member's capabilities in that organization; they filter `tools/list`. */
  readonly capabilities: ReadonlySet<string>;
}

export interface McpWorkspaceBinding {
  readonly userId: string;
  readonly organizationId: string;
  readonly membershipId: string;
}

export interface McpWorkspaceResolver {
  /** Resolve the binding, or `undefined` when the membership no longer matches it. */
  resolve(binding: McpWorkspaceBinding, correlationId: string): Promise<McpWorkspace | undefined>;
}

export const MCP_WORKSPACE_RESOLVER = Symbol.for('tmanage.McpWorkspaceResolver');

/** The production resolver: the same membership resolution `TenantContextGuard` runs. */
export class DatabaseMcpWorkspaceResolver implements McpWorkspaceResolver {
  constructor(
    private readonly database: TenantDatabase,
    private readonly memberships: MembershipResolver = new MembershipResolver(database),
    private readonly organizations: OrganizationsRepository = new OrganizationsRepository(),
  ) {}

  async resolve(
    binding: McpWorkspaceBinding,
    correlationId: string,
  ): Promise<McpWorkspace | undefined> {
    let resolved;
    try {
      resolved = await this.memberships.resolve({
        userId: binding.userId,
        organization: { organizationId: binding.organizationId },
        correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) return undefined;
      throw error;
    }
    const { context } = resolved;
    if (
      context.organizationId !== binding.organizationId ||
      context.membershipId !== binding.membershipId
    ) {
      return undefined;
    }
    const organization = await this.database.read(context, (runner) =>
      this.organizations.findCurrent(runner, context),
    );
    if (organization === null) return undefined;
    return { orgSlug: organization.slug, capabilities: new Set(context.capabilities) };
  }
}
