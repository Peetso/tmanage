import { AI_EMPLOYEE_MAX_LIVE_CREDENTIALS } from '@tmanage/domain';
import type { Provider } from '@nestjs/common';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  WORKS_AS_PORT,
  type ConsentWorksAsView,
  type WorksAsBinder,
  type WorksAsOptionView,
  type WorksAsPort,
  type WorksAsUnavailableReason,
} from '../oauth/works-as.js';
import { AiEmployeeSettingsRepository } from './ai-employee-settings.repository.js';
import type { AiEmployeeRecord } from './ai-employees.repository.js';
import { AiEmployeesRepository } from './ai-employees.repository.js';
import { aiEmployeesEnabled, aiEmployeesOff } from './ai-employees.switch.js';
import { connectionSummaries, mayBindAiEmployee } from './connections.js';

/**
 * 60-07 (plan 60 v2 §4.5, §4.6; screen S5) — the AI-employee side of the consent page's "This
 * agent works as": which AI employees a person may connect an app as, and the binding itself.
 *
 * Binding rules, all checked on the server inside the grant's transaction with the AI employee's
 * row locked (DA-1), so a page loaded earlier proves nothing:
 * 1. the server switch `TMANAGE_AI_EMPLOYEES` is on (off: 404, as for every AI-employee route);
 * 2. a person's own cookie session (no token, no AI principal);
 * 3. the workspace switch (`ai_employee_settings.enabled`) is on;
 * 4. the AI employee exists in this workspace (another workspace's id: 404);
 * 5. the person is its sponsor or holds `ai_employee.manage` ({@link mayBindAiEmployee});
 * 6. it is `active` (paused or retired: 409);
 * 7. it holds fewer than {@link AI_EMPLOYEE_MAX_LIVE_CREDENTIALS} live keys and connectors.
 * The grant then holds `tmanage:agent` only and names the person in
 * `authorized_by_membership_id` (`oauth.service.ts`); the audit row `ai_employee.connector_added`
 * commits with it (DA-11).
 */

export const AI_CONNECTOR_AUDIT = {
  added: 'ai_employee.connector_added',
  revoked: 'ai_employee.connector_revoked',
} as const;

export interface WorksAsServiceOptions {
  readonly database: Pick<TenantDatabase, 'read'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly repository: Pick<AiEmployeesRepository, 'list' | 'lockById' | 'findById'>;
  readonly settings: Pick<AiEmployeeSettingsRepository, 'read'>;
  /** Live keys + connectors per membership; `connectionSummaries` in production. */
  readonly summaries: typeof connectionSummaries;
  readonly enabled: boolean;
  readonly now?: () => Date;
}

function refused(status: 403 | 404 | 409, cause: string, message: string): ApiError {
  const code = status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'conflict';
  return new ApiError(status, code, message, undefined, cause);
}

/** A person's own browser session in this workspace: never a token, never an AI employee. */
function isPersonSession(context: TenantContext): boolean {
  return (
    context.actorChannel === undefined &&
    context.principalKind === 'internal' &&
    context.aiEmployee === undefined
  );
}

/** Pure: how one AI employee shows on the page for this person. */
export function worksAsOption(
  row: Pick<AiEmployeeRecord, 'id' | 'displayName' | 'jobTitle' | 'status'>,
  bindable: boolean,
  liveCredentials: number,
): WorksAsOptionView {
  let reason: WorksAsUnavailableReason | null = null;
  if (!bindable) reason = 'not_allowed';
  else if (row.status !== 'active') reason = 'paused';
  else if (liveCredentials >= AI_EMPLOYEE_MAX_LIVE_CREDENTIALS) reason = 'limit';
  return {
    id: row.id,
    displayName: row.displayName,
    jobTitle: row.jobTitle,
    available: reason === null,
    unavailableReason: reason,
  };
}

export class WorksAsService implements WorksAsPort {
  private readonly now: () => Date;

  constructor(private readonly deps: WorksAsServiceOptions) {
    this.now = deps.now ?? (() => new Date());
  }

  async options(context: TenantContext): Promise<ConsentWorksAsView> {
    const none: ConsentWorksAsView = { aiEmployees: [] };
    if (!this.deps.enabled || !isPersonSession(context)) return none;
    const at = this.now();
    return this.deps.database.read(context, async (db) => {
      if (!(await this.deps.settings.read(db, context)).enabled) return none;
      const rows = (await this.deps.repository.list(db, context)).filter(
        (row) => row.status !== 'retired',
      );
      const bindable = rows.filter((row) => mayBindAiEmployee(context, row.sponsorMembershipId));
      if (bindable.length === 0) return none;
      // Rows the person may not bind are shown dimmed ("Not allowed") only to someone who may see
      // the workspace's people anyway; otherwise they are left out.
      const shown = context.capabilities.includes('people.view') ? rows : bindable;
      const live = await this.deps.summaries(
        db,
        context,
        shown.map((row) => row.membershipId),
        at,
      );
      const aiEmployees = shown.map((row) =>
        worksAsOption(
          row,
          mayBindAiEmployee(context, row.sponsorMembershipId),
          live.get(row.membershipId)?.live ?? 0,
        ),
      );
      // Choosable first, then the dimmed ones; each group in the repository's (name) order.
      return {
        aiEmployees: [
          ...aiEmployees.filter((option) => option.available),
          ...aiEmployees.filter((option) => !option.available),
        ],
      };
    });
  }

  binder(aiEmployeeId: string): WorksAsBinder {
    return (tx, context, grantId) => this.bind(tx, context, aiEmployeeId, grantId);
  }

  private async bind(
    tx: TenantQueryRunner,
    context: TenantContext,
    aiEmployeeId: string,
    grantId: string,
  ) {
    if (!this.deps.enabled) throw aiEmployeesOff();
    if (!isPersonSession(context)) {
      throw refused(
        403,
        'ai_employee:person_session_only',
        'Only a person signed in to TManage can connect an app as an AI employee.',
      );
    }
    if (!(await this.deps.settings.read(tx, context)).enabled) {
      throw refused(403, 'ai_employee:workspace_off', 'AI employees are switched off here.');
    }
    const id = aiEmployeeId.toLowerCase();
    if (!(await this.deps.repository.lockById(tx, context, id))) {
      throw refused(404, 'ai_employee:not_found', 'Not found.');
    }
    const row = await this.deps.repository.findById(tx, context, id);
    if (row === null) throw refused(404, 'ai_employee:not_found', 'Not found.');
    if (!mayBindAiEmployee(context, row.sponsorMembershipId)) {
      throw refused(
        403,
        'ai_employee:not_sponsor',
        'Only the sponsor or someone who manages AI employees can do this.',
      );
    }
    if (row.status !== 'active') {
      throw refused(
        409,
        row.status === 'paused' ? 'ai_employee:paused' : 'ai_employee:retired',
        'This AI employee is paused or retired.',
      );
    }
    const live = (await this.deps.summaries(tx, context, [row.membershipId], this.now())).get(
      row.membershipId,
    );
    if ((live?.live ?? 0) >= AI_EMPLOYEE_MAX_LIVE_CREDENTIALS) {
      throw refused(
        409,
        'ai_employee:credential_limit',
        `An AI employee can have at most ${AI_EMPLOYEE_MAX_LIVE_CREDENTIALS} live keys or connections.`,
      );
    }
    await this.deps.audit.record(tx, context, {
      action: AI_CONNECTOR_AUDIT.added,
      result: 'allowed',
      objectId: row.id,
      actorUserId: context.userId,
      metadata: { grant_id: grantId },
    });
    return { membershipId: row.membershipId, userId: row.userId };
  }
}

/** Registered by `OAuthModule` (the consumer), like `platformConsentCheckProvider`. */
export const worksAsProvider: Provider = {
  provide: WORKS_AS_PORT,
  inject: [TENANT_DATABASE, AUDIT_SERVICE],
  useFactory: (database: TenantDatabase, audit: AuditService): WorksAsPort =>
    new WorksAsService({
      database,
      audit,
      repository: new AiEmployeesRepository(),
      settings: new AiEmployeeSettingsRepository(),
      summaries: connectionSummaries,
      enabled: aiEmployeesEnabled(process.env),
    }),
};
