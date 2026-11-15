import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { parseAutomationFlow, uuidv7 } from '@tmanage/domain';
import type { AutomationFlow } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workflowFlowVersions } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 58-C1 — the saved versions of a rule's branching builder graph (`workflow_flow_versions`, 0350).
 * Append-only: a save writes version n + 1 and the highest version is the one in force. Tenant from
 * the context on every statement; the template id is one the caller already resolved in this tenant.
 */

export interface SavedFlow {
  readonly version: number;
  readonly flow: AutomationFlow;
}

export class WorkflowFlowVersionsRepository {
  /**
   * The version in force, or `null` for a linear rule. The stored graph is re-checked on the way out
   * (`parseAutomationFlow`); a row that no longer parses — an action kind since retired — reads as
   * `null` flow with its version, so the caller refuses to run it rather than guessing.
   */
  async latest(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<SavedFlow | { readonly version: number; readonly flow: null } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ version: workflowFlowVersions.version, flowJson: workflowFlowVersions.flowJson })
      .from(workflowFlowVersions)
      .where(
        and(
          eq(workflowFlowVersions.organizationId, context.organizationId),
          eq(workflowFlowVersions.templateId, templateId),
        ),
      )
      .orderBy(desc(workflowFlowVersions.version))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const parsed = parseAutomationFlow(row.flowJson);
    return { version: row.version, flow: parsed.ok ? parsed.flow : null };
  }

  /**
   * Append a new version. The next number is read in the same transaction; two racing saves meet the
   * `(organization_id, template_id, version)` unique key and the loser fails rather than overwriting.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    flow: AutomationFlow,
  ): Promise<number> {
    const current = await this.latest(runner, context, templateId);
    const version = (current?.version ?? 0) + 1;
    await tenantDrizzle(runner)
      .insert(workflowFlowVersions)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        templateId,
        version,
        flowJson: { start: flow.start, nodes: flow.nodes.map((node) => ({ ...node })) },
        createdBy: context.userId,
        createdAt: sql`current_timestamp(3)`,
      });
    return version;
  }
}
