import { uuidv7 } from '@tmanage/domain';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { DEFAULT_USER_PREFERENCES } from '../preferences/preferences.controller.js';
import {
  BACKUP_FRESH_DAYS,
  parseStoredChecklist,
  requiresTwoStep,
} from './getting-started.steps.js';
import type {
  ChecklistSignals,
  SetupHealthSignals,
  StoredChecklist,
} from './getting-started.steps.js';

/**
 * 55-11 / 55-22 — the checklist's and Setup health's reads, and the one write (the member's own
 * `gettingStarted` key in `user_preferences.prefs_json`, merged with `json_merge_patch` so the
 * appearance keys and every other surface's key survive — the 53-15 matrix pattern). Every
 * statement names the context's organization; the stored key is always the acting membership's.
 */
export class GettingStartedRepository {
  async readStored(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<StoredChecklist> {
    const rows = await runner.execute<QueryRows>(
      `select json_extract(prefs_json, '$.gettingStarted') as gs_json
         from user_preferences
        where organization_id = ? and membership_id = ?
        limit 1`,
      [context.organizationId, membershipId],
    );
    return parseStoredChecklist(rows[0]?.['gs_json'] ?? null);
  }

  async writeStored(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    stored: StoredChecklist,
  ): Promise<void> {
    const gettingStarted = { marked: stored.marked, dismissedAt: stored.dismissedAt };
    await runner.execute(
      `insert into user_preferences
         (id, organization_id, membership_id, prefs_json, created_at, updated_at)
       values (?, ?, ?, ?, current_timestamp(3), current_timestamp(3))
       on duplicate key update prefs_json = json_merge_patch(prefs_json, ?),
                               updated_at = current_timestamp(3)`,
      [
        uuidv7(),
        context.organizationId,
        membershipId,
        JSON.stringify({ ...DEFAULT_USER_PREFERENCES, gettingStarted }),
        JSON.stringify({ gettingStarted }),
      ],
    );
  }

  /** One round trip: what the company's data already proves for each checklist step. */
  async readSignals(runner: TenantQueryRunner, context: TenantContext): Promise<ChecklistSignals> {
    const org = context.organizationId;
    const rows = await runner.execute<QueryRows>(
      `select
         exists(select 1 from invitations where organization_id = ? and client_organization_id is null)
           or (select count(*) from memberships
                where organization_id = ? and status = 'active') > 1
           as invite_teammate,
         exists(select 1 from projects where organization_id = ?) as create_project,
         exists(select 1 from client_organizations where organization_id = ?) as add_client,
         exists(select 1 from storage_connections
                 where organization_id = ? and status = 'connected') as connect_storage,
         exists(select 1 from org_working_calendars
                 where organization_id = ? and scope = 'org') as set_working_hours,
         exists(select 1 from oauth_grants
                 where organization_id = ? and user_id = ? and revoked_at is null) as try_ai_assistant`,
      [org, org, org, org, org, org, org, context.userId],
    );
    const row: Readonly<Record<string, unknown>> = rows[0] ?? {};
    const flag = (key: string) => Boolean(Number(row[key] ?? 0));
    return {
      invite_teammate: flag('invite_teammate'),
      create_project: flag('create_project'),
      add_client: flag('add_client'),
      connect_storage: flag('connect_storage'),
      set_working_hours: flag('set_working_hours'),
      try_ai_assistant: flag('try_ai_assistant'),
    };
  }

  /** The owner's Setup health facts, in one round trip. */
  async readHealth(runner: TenantQueryRunner, context: TenantContext): Promise<SetupHealthSignals> {
    const org = context.organizationId;
    const rows = await runner.execute<QueryRows>(
      `select
         exists(select 1 from storage_connections
                 where organization_id = ? and status = 'connected') as storage_connected,
         (select json_unquote(json_extract(policy_json, '$."security.require_two_step_roles"'))
            from org_policies where organization_id = ? limit 1) as two_step_roles,
         exists(select 1 from admin_export_requests
                 where organization_id = ? and status = 'completed'
                   and requested_at >= current_timestamp(3) - interval ${String(BACKUP_FRESH_DAYS)} day)
           as recent_export,
         exists(select 1 from inbound_email_addresses
                 where organization_id = ? and status = 'active') as mail_in_active`,
      [org, org, org, org],
    );
    const row: Readonly<Record<string, unknown>> = rows[0] ?? {};
    const flag = (key: string) => Boolean(Number(row[key] ?? 0));
    return {
      storageConnected: flag('storage_connected'),
      twoStepRequired: requiresTwoStep(row['two_step_roles']),
      recentExport: flag('recent_export'),
      mailInActive: flag('mail_in_active'),
    };
  }
}
