import { parseAiEmployeeStatus, type AiEmployeeStatus } from '@tmanage/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  aiEmployees,
  aiExcludedProjects,
  projectMemberships,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import {
  AiEmployeeSettingsRepository,
  type AiEmployeeSettings,
} from './ai-employee-settings.repository.js';
import { connectionSummaries } from './connections.js';

/**
 * 60-08 (plan 60 v2 §2.2 step 5, §4.6 rule 6, §4.7) — what the Work module and the member
 * directory need to know about AI employees, read here so the AI-employee tables stay read by the
 * module that owns them (AR-7). Bound SQL only (DA-3); every statement carries the organization
 * from the verified context (DA-12). No writes.
 */

/** One AI employee as an assign decision needs it, keyed by its user id. */
export interface AiAssigneeFacts {
  readonly userId: string;
  readonly status: AiEmployeeStatus | null;
  /** A `project_memberships` row on the work's project: the project is one of his (§4.6 rule 6). */
  readonly onProject: boolean;
}

/** Everything one assign decision reads, in one place. */
export interface AiAssignFacts {
  readonly settings: Pick<AiEmployeeSettings, 'enabled' | 'assignPolicy'>;
  /** The workspace closed this project to AI employees (M5, `ai_excluded_projects`). */
  readonly projectClosed: boolean;
  readonly employees: ReadonlyMap<string, AiAssigneeFacts>;
}

/** The read behind {@link AiAssignFacts}. Stateless, so a default instance is safe. */
export class AiAssignFactsReader {
  constructor(
    private readonly settings: Pick<
      AiEmployeeSettingsRepository,
      'read'
    > = new AiEmployeeSettingsRepository(),
  ) {}

  async read(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    userIds: readonly string[],
  ): Promise<AiAssignFacts> {
    const settings = await this.settings.read(runner, context);
    const db = tenantDrizzle(runner);
    const closed = await db
      .select({ projectId: aiExcludedProjects.projectId })
      .from(aiExcludedProjects)
      .where(
        and(
          eq(aiExcludedProjects.organizationId, context.organizationId),
          eq(aiExcludedProjects.projectId, projectId),
        ),
      )
      .limit(1);
    const employees = new Map<string, AiAssigneeFacts>();
    if (userIds.length > 0) {
      const rows = await db
        .select({ userId: aiEmployees.userId, status: aiEmployees.status })
        .from(aiEmployees)
        .where(
          and(
            eq(aiEmployees.organizationId, context.organizationId),
            inArray(aiEmployees.userId, [...userIds]),
          ),
        );
      const onProject = new Set(
        (
          await db
            .select({ userId: projectMemberships.userId })
            .from(projectMemberships)
            .where(
              and(
                eq(projectMemberships.organizationId, context.organizationId),
                eq(projectMemberships.projectId, projectId),
                inArray(projectMemberships.userId, [...userIds]),
              ),
            )
        ).map((row) => row.userId),
      );
      for (const row of rows) {
        employees.set(row.userId, {
          userId: row.userId,
          status: parseAiEmployeeStatus(row.status),
          onProject: onProject.has(row.userId),
        });
      }
    }
    return {
      settings: { enabled: settings.enabled, assignPolicy: settings.assignPolicy },
      projectClosed: closed.length > 0,
      employees,
    };
  }
}

/** Why an AI employee cannot be chosen in a picker now, or `available`. The server decides (AR-9). */
export type AiAvailability = 'available' | 'paused' | 'not_connected' | 'switched_off';

/** The AI part of a member directory row (S7: the mark, the job line and the reason). */
export interface AiMemberMark {
  readonly jobTitle: string;
  readonly status: 'active' | 'paused';
  /** At least one live credential (an agent key; 60-05 grants join the same summary). */
  readonly connected: boolean;
  readonly availability: AiAvailability;
}

/**
 * The marks for the AI members of one directory page, keyed by membership id. Retired AI employees
 * are offboarded members and never reach the directory, so only `active` and `paused` are mapped;
 * a row whose status cannot be read is shown as paused (deny by default).
 */
export async function readAiMemberMarks(
  runner: TenantQueryRunner,
  context: TenantContext,
  membershipIds: readonly string[],
  at: Date,
  settings: Pick<AiEmployeeSettingsRepository, 'read'> = new AiEmployeeSettingsRepository(),
): Promise<ReadonlyMap<string, AiMemberMark>> {
  const out = new Map<string, AiMemberMark>();
  if (membershipIds.length === 0) return out;
  const rows = await tenantDrizzle(runner)
    .select({
      membershipId: aiEmployees.membershipId,
      jobTitle: aiEmployees.jobTitle,
      status: aiEmployees.status,
    })
    .from(aiEmployees)
    .where(
      and(
        eq(aiEmployees.organizationId, context.organizationId),
        inArray(aiEmployees.membershipId, [...membershipIds]),
      ),
    );
  if (rows.length === 0) return out;
  const workspace = await settings.read(runner, context);
  const connections = await connectionSummaries(
    runner,
    context,
    rows.map((row) => row.membershipId),
    at,
  );
  for (const row of rows) {
    const status = parseAiEmployeeStatus(row.status) === 'active' ? 'active' : 'paused';
    const connected = (connections.get(row.membershipId)?.live ?? 0) > 0;
    out.set(row.membershipId, {
      jobTitle: row.jobTitle,
      status,
      connected,
      availability: aiAvailability(workspace.enabled, status, connected),
    });
  }
  return out;
}

/** The picker reason, most important first: the workspace switch, then paused, then no connection. */
export function aiAvailability(
  workspaceEnabled: boolean,
  status: 'active' | 'paused',
  connected: boolean,
): AiAvailability {
  if (!workspaceEnabled) return 'switched_off';
  if (status !== 'active') return 'paused';
  if (!connected) return 'not_connected';
  return 'available';
}
