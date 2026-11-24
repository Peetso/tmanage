import { eq, and, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  aiEmployeeSettings,
  type AI_ASSIGN_POLICY_VALUES,
  type AI_CLIENT_WORK_VALUES,
  type AI_HIRE_POLICY_VALUES,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * 60-07 (0415, S8) — a workspace's rules for AI employees. One row per workspace; no row reads as
 * {@link AI_EMPLOYEE_SETTINGS_DEFAULTS}, so a workspace that never opened the page behaves like
 * one that saved the defaults. Bound SQL only (DA-3), the organization from the verified context
 * (DA-12), times bound by the service (DA-10), writes conditional on `version` (DA-1).
 *
 * Read by the settings routes, by the hire and assign decisions (the policies narrow
 * `ai_employee.manage` / `ai_employee.assign`) and by the agent gate (the switch, client work).
 */

export type AiHirePolicy = (typeof AI_HIRE_POLICY_VALUES)[number];
export type AiAssignPolicy = (typeof AI_ASSIGN_POLICY_VALUES)[number];
export type AiClientWork = (typeof AI_CLIENT_WORK_VALUES)[number];

export interface AiEmployeeSettings {
  readonly enabled: boolean;
  readonly hirePolicy: AiHirePolicy;
  readonly assignPolicy: AiAssignPolicy;
  readonly clientWork: AiClientWork;
  readonly discloseToClients: boolean;
  readonly secondApprover: boolean;
  /** 0 = no row yet (the first save inserts); otherwise the stored version. */
  readonly version: number;
}

export type AiEmployeeSettingsChange = Partial<Omit<AiEmployeeSettings, 'version'>>;

export const AI_EMPLOYEE_SETTINGS_DEFAULTS: AiEmployeeSettings = Object.freeze({
  enabled: true,
  hirePolicy: 'owners_and_admins',
  assignPolicy: 'managers',
  clientWork: 'allowed',
  discloseToClients: true,
  secondApprover: true,
  version: 0,
});

export class AiEmployeeSettingsRepository {
  async read(runner: TenantQueryRunner, context: TenantContext): Promise<AiEmployeeSettings> {
    const rows = await tenantDrizzle(runner)
      .select({
        enabled: aiEmployeeSettings.enabled,
        hirePolicy: aiEmployeeSettings.hirePolicy,
        assignPolicy: aiEmployeeSettings.assignPolicy,
        clientWork: aiEmployeeSettings.clientWork,
        discloseToClients: aiEmployeeSettings.discloseToClients,
        secondApprover: aiEmployeeSettings.secondApprover,
        version: aiEmployeeSettings.version,
      })
      .from(aiEmployeeSettings)
      .where(eq(aiEmployeeSettings.organizationId, context.organizationId))
      .limit(1);
    return rows[0] ?? AI_EMPLOYEE_SETTINGS_DEFAULTS;
  }

  /**
   * Save at `expectedVersion`. Version 0 inserts the first row (a concurrent first save hits the
   * primary key and is reported as stale); any other version is a conditional UPDATE. `true` when
   * this call wrote, `false` when someone saved first (the caller answers 409).
   */
  async save(
    runner: TenantQueryRunner,
    context: TenantContext,
    expectedVersion: number,
    next: Omit<AiEmployeeSettings, 'version'>,
    at: Date,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    if (expectedVersion === 0) {
      const inserted = await db
        .insert(aiEmployeeSettings)
        .ignore()
        .values({
          organizationId: context.organizationId,
          ...next,
          version: 1,
          updatedByMembershipId: context.membershipId,
          updatedAt: at,
        });
      return inserted[0].affectedRows === 1;
    }
    const result = await db
      .update(aiEmployeeSettings)
      .set({
        ...next,
        version: sql`${aiEmployeeSettings.version} + 1`,
        updatedByMembershipId: context.membershipId,
        updatedAt: at,
      })
      .where(
        and(
          eq(aiEmployeeSettings.organizationId, context.organizationId),
          eq(aiEmployeeSettings.version, expectedVersion),
        ),
      );
    return result[0].affectedRows === 1;
  }
}
