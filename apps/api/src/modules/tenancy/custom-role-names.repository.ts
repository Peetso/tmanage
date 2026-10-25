import { and, eq, inArray } from 'drizzle-orm';
import { isCustomRoleId, isRole, parseCustomRoleCapabilities } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { customRoles } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * H1 — a custom role's own name (and loaded set) for any member who can see the role on a person.
 *
 * `memberships.role` stores a custom role's id. The People list and the organization switcher
 * used to hand that id to the browser, which could only name it through Control > Roles — a page
 * behind `org.manage` — so every other viewer saw "Custom role". This reads the names on the
 * caller's own tenant-scoped path: the `organization_id` predicate binds the active context, so
 * a role id from another studio simply does not match and is never named.
 *
 * Only the name and the allowlisted capabilities are returned; nothing about who made the role.
 */
export interface CustomRoleSummary {
  readonly name: string;
  readonly capabilities: readonly Capability[];
}

/** The custom role ids among stored role values, lowercased and de-duplicated. Pure. */
export function customRoleIdsAmong(roles: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const role of roles) {
    if (isRole(role)) continue;
    const id = role.toLowerCase();
    if (isCustomRoleId(id)) ids.add(id);
  }
  return [...ids];
}

export class CustomRoleNamesRepository {
  /** Name and set for each custom role id stored on these rows; built-in names are skipped. */
  async describe(
    runner: TenantQueryRunner,
    context: TenantContext,
    roles: Iterable<string>,
  ): Promise<ReadonlyMap<string, CustomRoleSummary>> {
    const ids = customRoleIdsAmong(roles);
    const out = new Map<string, CustomRoleSummary>();
    if (ids.length === 0) return out;
    const rows = await tenantDrizzle(runner)
      .select({
        id: customRoles.id,
        name: customRoles.name,
        capabilitiesJson: customRoles.capabilitiesJson,
      })
      .from(customRoles)
      .where(
        and(eq(customRoles.organizationId, context.organizationId), inArray(customRoles.id, ids)),
      );
    for (const row of rows) {
      out.set(row.id.toLowerCase(), {
        name: row.name,
        capabilities: parseCustomRoleCapabilities(row.capabilitiesJson),
      });
    }
    return out;
  }
}

/** The summary for one stored role value, or undefined for a built-in role or an unknown id. */
export function customRoleSummaryOf(
  summaries: ReadonlyMap<string, CustomRoleSummary>,
  role: string,
): CustomRoleSummary | undefined {
  return isRole(role) ? undefined : summaries.get(role.toLowerCase());
}
